const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRecorder,
  boot,
  parseStack,
  isSecretName,
  looksSecret,
  scrub,
  summarize,
  clip,
  isServiceNowHost,
  ARM_KEY,
  REQUEST_EVENT,
  RESPONSE_EVENT,
  ARM_DURATION_MS,
  HIDDEN,
  LIMITS,
} = require('../src/lib/clientTraceRecorder.js');
const trace = require('../src/lib/clientTrace.js');

// ---------------------------------------------------------------------------------------------------------------------
// Fakes: a window-like object, a g_form, GlideAjax, GlideRecord, XMLHttpRequest, fetch. Nothing here is a browser.
// ---------------------------------------------------------------------------------------------------------------------

function makeTimers() {
  let next = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      next += 1;
      timers.set(next, { fn, ms, repeat: false });
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval(fn, ms) {
      next += 1;
      timers.set(next, { fn, ms, repeat: true });
      return next;
    },
    clearInterval: (id) => timers.delete(id),
    fireTimeouts() {
      [...timers.entries()].forEach(([id, t]) => {
        if (!t.repeat) {
          timers.delete(id);
          t.fn();
        }
      });
    },
    tickIntervals(n = 1) {
      for (let i = 0; i < n; i += 1) [...timers.values()].filter((t) => t.repeat).forEach((t) => t.fn());
    },
    get size() {
      return timers.size;
    },
    intervals: () => [...timers.values()].filter((t) => t.repeat).length,
  };
}

// `top: 'self'` makes the window the top frame; by default it is a sub-frame (the classic form frame).
function makeWindow({ href = 'https://dev1.service-now.com/incident.do?sys_id=abc', name = 'gsft_main', top = {} } = {}) {
  const clock = { t: 0, epoch: 1_700_000_000_000, explode: false };
  const storage = new Map();
  const listeners = {};
  const timers = makeTimers();
  const doc = new EventTarget();
  doc.readyState = 'complete';
  const u = new URL(href);
  const win = {
    document: doc,
    location: { href, origin: u.origin, hostname: u.hostname },
    name,
    Error,
    URL,
    CustomEvent,
    performance: { now: () => clock.t },
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    console: { error() {}, warn() {} },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
  };
  win.top = top === 'self' ? win : top;
  win._fire = (type, props = {}) => (listeners[type] || []).slice().forEach((fn) => fn({ target: win, ...props }));
  win._listeners = listeners;
  win._clock = clock;
  win._timers = timers;
  win._storage = storage;
  return win;
}

const STACK = [{ fn: 'onChange_6816f79cc0a8016401c5a33be04be441', line: 12, col: 5, url: '/incident.do' }];

function makeRecorder(win, extra = {}) {
  return createRecorder(win, {
    now: () => {
      if (win._clock.explode) throw new Error('clock failed');
      return win._clock.t;
    },
    epoch: () => win._clock.epoch,
    captureStack: () => STACK.map((f) => ({ ...f })),
    rid: 'rid1',
    pageMarkers: false, // the start-up page events are tested on their own

    ...extra,
  });
}

const makeFormClass = () =>
  class FakeForm {
  constructor() {
    this.values = { short_description: 'old', category: 'hardware', user_password: 'hunter2', priority: '3' };
    this.log = [];
  }
  hasField(f) {
    return Object.prototype.hasOwnProperty.call(this.values, f);
  }
  getValue(f) {
    return this.values[f];
  }
  getControl(f) {
    return f === 'secret_note' ? { type: 'password' } : null;
  }
  setValue(f, v, d) {
    this.log.push({ self: this, args: Array.from(arguments) });
    if (Object.prototype.hasOwnProperty.call(this.values, f)) this.values[f] = v;
    return `set:${f}`;
  }
  clearValue(f) {
    if (Object.prototype.hasOwnProperty.call(this.values, f)) this.values[f] = '';
  }
  setMandatory(f, on) {
    this.log.push({ self: this, args: Array.from(arguments) });
    return on;
  }
  addInfoMessage(m) {
    return `msg:${m}`;
  }
  save() {
    return 'saved';
  }
  getEditableFields() {
    return [];
  }
};
const newForm = () => new (makeFormClass())();

const makeAjaxClass = () => {
  class FakeAjax {
  constructor(cls) {
    this.initialize(cls);
  }
  initialize(cls) {
    this.processor = cls;
    this.params = {};
    this.addParam('sysparm_processor', cls);
  }
  addParam(n, v) {
    this.params[n] = v;
  }
  getXML(cb) {
    FakeAjax.pending.push(cb);
  }
  getXMLWait() {
    FakeAjax.waited = (FakeAjax.waited || 0) + 1;
    return undefined;
  }
  getXMLAnswer(cb) {
    // like the real class, built on getXML
    this.getXML((response) => cb(response.answer));
  }
}
  FakeAjax.pending = [];
  return FakeAjax;
};

const makeGlideRecordClass = () => {
  class FakeGlideRecord {
  constructor(table) {
    this.tableName = table;
    this.q = '';
  }
  addQuery(f, v) {
    this.q += `${f}=${v}^`;
  }
  getEncodedQuery() {
    return this.q.replace(/\^$/, '');
  }
  query(cb) {
    if (typeof cb === 'function') FakeGlideRecord.pending.push(cb);
    return 'queried';
  }
  get(a, b, c) {
    return this.query(typeof c === 'function' ? c : undefined);
  }
}
  FakeGlideRecord.pending = [];
  return FakeGlideRecord;
};

const armedRecorder = (win, extra) => {
  const rec = makeRecorder(win, extra);
  rec.start(win._clock.epoch + ARM_DURATION_MS);
  return rec;
};

// ---------------------------------------------------------------------------------------------------------------------
// Redaction, summaries, stacks
// ---------------------------------------------------------------------------------------------------------------------

test('secret names: password, secret, token and key anywhere in the name', () => {
  ['password', 'u_password', 'user_password2', 'client_secret', 'api_key', 'auth_token', 'sysparm_ck', 'Authorization', 'private_key'].forEach((n) => assert.equal(isSecretName(n), true, n));
  ['short_description', 'caller_id', 'sysparm_name', 'category', '', null, undefined, 42].forEach((n) => assert.equal(isSecretName(n), false, String(n)));
});

test('values that look like credentials are hidden whatever they are called; sys_ids and ordinary text are not', () => {
  assert.equal(looksSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'), true);
  assert.equal(looksSecret('Bearer abcdefghijklmnop1234'), true);
  assert.equal(looksSecret('-----BEGIN PRIVATE KEY-----\nMIIE'), true);
  assert.equal(looksSecret('sk1abcDEF2ghiJKL3mnoPQR4stuVWX5yzaBCD6efGH'), true);
  assert.equal(looksSecret('6816f79cc0a8016401c5a33be04be441'), false);
  assert.equal(looksSecret('Printer on floor 3 is jammed again and nobody has looked at it'), false);
  assert.equal(looksSecret(''), false);
  assert.equal(summarize('Bearer abcdefghijklmnop1234'), HIDDEN);
});

test('free text loses password=... and token: ... values and is capped', () => {
  assert.equal(scrub('login failed password=hunter2 for bob'), `login failed password=${HIDDEN} for bob`);
  assert.equal(scrub('{"token":"abc123def","x":1}'), `{"token":"${HIDDEN}","x":1}`);
  assert.equal(scrub('x'.repeat(500)).length, LIMITS.text);
  assert.equal(clip('abcdef', 4), 'abc…');
});

test('summarize never throws and never calls into the page: accessors, cycles, functions, elements, errors', () => {
  const evil = {};
  Object.defineProperty(evil, 'boom', {
    enumerable: true,
    get() {
      throw new Error('getter ran');
    },
  });
  evil.self = evil;
  assert.doesNotThrow(() => summarize(evil));
  assert.equal(typeof summarize(evil), 'string');
  assert.equal(summarize(undefined), null);
  assert.equal(summarize(NaN), 'NaN');
  assert.equal(summarize(function namedFn() {}), '[function namedFn]');
  assert.equal(summarize(new TypeError('bad')), 'TypeError: bad');
  assert.equal(summarize({ nodeType: 1, tagName: 'INPUT', id: 'x' }), '<input#x>');
  assert.match(summarize([1, 'a', { b: 2 }]), /^\[1, "a", \{b: 2\}\]$/);
  assert.equal(summarize('y'.repeat(900)).length, LIMITS.text);
  assert.equal(summarize(true), true);
});

const V8_STACK = `Error: x
    at msbGForm (chrome-extension://abc/recorder.js:10:5)
    at GlideForm.msbGForm (chrome-extension://abc/recorder.js:11:5)
    at onChange_6816f79cc0a8016401c5a33be04be441 (https://dev1.service-now.com/incident.do?sys_id=abc&sysparm_ck=SECRET:120:15)
    at Object.<anonymous> (https://dev1.service-now.com/scripts/my_lib.jsdbx?v=1:7:3)
    at new Foo (https://other.example.com/a.js:1:2)
    at async runner (https://dev1.service-now.com/x.js:5:6)
    at https://dev1.service-now.com/y.js:9:9
    at eval (eval at make (https://dev1.service-now.com/z.js:3:4), <anonymous>:1:7)
    at deep1 (https://dev1.service-now.com/d.js:1:1)
    at deep2 (https://dev1.service-now.com/d.js:2:1)
    at deep3 (https://dev1.service-now.com/d.js:3:1)`;

test('V8 stacks: the recorder frames are dropped, query strings removed, same-origin urls shortened, at most 8 frames', () => {
  const frames = parseStack(V8_STACK, { origin: 'https://dev1.service-now.com' });
  assert.equal(frames.length, 8);
  assert.deepEqual(frames[0], { fn: 'onChange_6816f79cc0a8016401c5a33be04be441', line: 120, col: 15, url: '/incident.do' });
  assert.deepEqual(frames[1], { fn: 'Object.<anonymous>', line: 7, col: 3, url: '/scripts/my_lib.jsdbx' });
  assert.equal(frames[2].url, 'https://other.example.com/a.js');
  assert.equal(frames[3].fn, 'runner');
  assert.deepEqual(frames[4], { fn: '', line: 9, col: 9, url: '/y.js' });
  assert.deepEqual(frames[5], { fn: 'eval', line: 1, col: 7 });
  assert.ok(!JSON.stringify(frames).includes('SECRET'), 'the query string (which can hold a token) is never kept');
});

test('frames from the recorder file are dropped by url as well as by name', () => {
  const text = 'Error\n    at wrap (chrome-extension://abc/recorder.js:1:1)\n    at user (https://x.service-now.com/a.js:2:2)';
  assert.deepEqual(
    parseStack(text, { skipUrl: 'chrome-extension://abc/recorder.js', origin: 'https://x.service-now.com' }).map((f) => f.fn),
    ['user']
  );
});

test('Firefox and Safari stacks parse too, and a message containing @ is not a frame in a V8 stack', () => {
  const ff = 'setValue@https://x.service-now.com/a.js:3:9\nonLoad_aa@https://x.service-now.com/b.js:4:1';
  assert.deepEqual(parseStack(ff, { origin: 'https://x.service-now.com' }), [
    { fn: 'setValue', line: 3, col: 9, url: '/a.js' },
    { fn: 'onLoad_aa', line: 4, col: 1, url: '/b.js' },
  ]);
  const v8 = 'Error: mail bob@example.com failed\n    at f (https://x.service-now.com/a.js:1:2)';
  assert.equal(parseStack(v8).length, 1);
  assert.deepEqual(parseStack(''), []);
  assert.deepEqual(parseStack(undefined), []);
});

test('only ServiceNow hosts are recorded', () => {
  assert.equal(isServiceNowHost('dev1.service-now.com'), true);
  assert.equal(isServiceNowHost('service-now.com'), true);
  assert.equal(isServiceNowHost('evil-service-now.com'), false);
  assert.equal(isServiceNowHost('service-now.com.evil.example'), false);
  assert.equal(isServiceNowHost('localhost'), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// g_form wrappers
// ---------------------------------------------------------------------------------------------------------------------

test('a wrapped g_form call returns the same value, keeps `this`, passes every argument through and records the call', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  win.g_form = form;
  rec._hook('g_form', form);
  const result = form.setValue('short_description', 'new text', 'display', 'extra');
  assert.equal(result, 'set:short_description');
  assert.equal(form.log[0].self, form);
  assert.deepEqual(form.log[0].args, ['short_description', 'new text', 'display', 'extra']);
  assert.equal(form.values.short_description, 'new text');
  const [event] = rec.events();
  assert.equal(event.kind, 'field');
  assert.equal(event.name, 'g_form.setValue');
  assert.equal(event.field, 'short_description');
  assert.deepEqual(event.args, ['new text', 'display', 'extra']);
  assert.deepEqual(event.result, { before: 'old', after: 'new text', changed: true });
  assert.equal(event.frame, 'gsft_main');
  assert.deepEqual(event.stack, STACK);
  assert.equal(typeof event.durationMs, 'number');
  assert.equal(event.id, 1);
  assert.equal(event.seq, 1);
});

test('a call made with another `this` (call/apply) is passed through unchanged', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  rec._hook('g_form', form);
  const other = newForm();
  assert.equal(form.setValue.call(other, 'category', 'software'), 'set:category');
  assert.equal(other.values.category, 'software');
  assert.equal(form.values.category, 'hardware');
});

test('an exception from the original is rethrown as the very same object, and is recorded', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  const boom = new Error('page broke');
  form.addInfoMessage = function () {
    throw boom;
  };
  rec._hook('g_form', form);
  assert.throws(() => form.addInfoMessage('hi'), (err) => err === boom);
  const [event] = rec.events();
  assert.equal(event.flags.threw, true);
  assert.match(event.result.error, /page broke/);
});

test('if recording throws, the original still runs and its value is returned', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  rec._hook('g_form', form);
  win._clock.explode = true; // every timestamp read now throws: begin() fails before the call
  assert.equal(form.setValue('category', 'network'), 'set:category');
  assert.equal(form.values.category, 'network');
  win._clock.explode = false;
  assert.equal(rec.events().length, 0);
  // and a failure AFTER the call (the original itself breaks the clock) is swallowed too
  const form2 = newForm();
  form2.setMandatory = function (f, on) {
    win._clock.explode = true;
    return on;
  };
  rec._hook('g_form', form2);
  assert.equal(form2.setMandatory('category', true), true);
  win._clock.explode = false;
  // the failed call left nothing behind that would adopt later events as children
  form.setValue('priority', '1');
  const last = rec.events().pop();
  assert.equal(last.name, 'g_form.setValue');
  assert.equal(last.parent, undefined);
});

test('hasField / getValue / getControl throwing never stops the call', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  form.hasField = () => {
    throw new Error('x');
  };
  form.getValue = () => {
    throw new Error('y');
  };
  form.getControl = () => {
    throw new Error('z');
  };
  rec._hook('g_form', form);
  assert.equal(form.setValue('category', 'q'), 'set:category');
  assert.equal(rec.events().length, 1);
});

test('a field that is not on the form is flagged (ServiceNow ignores the call)', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  rec._hook('g_form', form);
  form.setValue('u_does_not_exist', 'x');
  form.setMandatory('u_also_missing', true);
  const [a, b] = rec.events();
  assert.equal(a.flags.unknownField, true);
  assert.equal(a.result, undefined, 'no before/after for a field that is not there');
  assert.equal(b.flags.unknownField, true);
  form.setValue('category', 'ok');
  assert.equal(rec.events()[2].flags, undefined);
});

test('values of password-type fields, secret-named fields and credential-looking values are never recorded', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  form.values.api_token = 'abc';
  form.values.secret_note = 'x';
  form.values.notes = 'x';
  rec._hook('g_form', form);
  form.setValue('user_password', 'hunter2');
  form.setValue('api_token', 'tok-123');
  form.setValue('secret_note', 'shh'); // the control is a password input
  form.setValue('notes', 'Bearer abcdefghijklmnop1234');
  form.clearValue('user_password');
  const events = rec.events();
  assert.deepEqual(events[0].args, [HIDDEN]);
  assert.equal(events[0].result, undefined);
  assert.deepEqual(events[1].args, [HIDDEN]);
  assert.deepEqual(events[2].args, [HIDDEN]);
  assert.deepEqual(events[3].args, [HIDDEN]);
  assert.equal(events[3].result.after, HIDDEN);
  assert.equal(events[4].result, undefined);
  const dump = JSON.stringify(events);
  ['hunter2', 'tok-123', 'shh', 'abcdefghijklmnop1234'].forEach((s) => assert.ok(!dump.includes(s), `${s} must not be stored`));
});

test('setValue that changes nothing is reported as unchanged; clearValue records what was cleared', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  rec._hook('g_form', form);
  form.setValue('category', 'hardware');
  form.clearValue('category');
  const [a, b] = rec.events();
  assert.equal(a.result.changed, false);
  assert.deepEqual(b.result, { before: 'hardware', after: '', changed: true });
});

test('long values are capped, the argument list is capped', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  rec._hook('g_form', form);
  form.setValue('short_description', 'z'.repeat(5000));
  form.addInfoMessage.apply(form, Array.from({ length: 30 }, (_, i) => `a${i}`));
  const [a, b] = rec.events();
  assert.equal(a.args[0].length, LIMITS.text);
  assert.equal(b.args.length, LIMITS.args);
});

test('the platform calling itself with the same arguments is not recorded twice; a script it triggers is a child', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  const original = form.setValue;
  // setValue('a') -> (internal, identical) setValue('a') and -> an onChange script calling setValue('b')
  form.setValue = function (f, v) {
    const r = original.call(this, f, v);
    if (f === 'category' && !this.inner) {
      this.inner = true;
      this.setValue('category', v); // internal duplicate
      this.setValue('priority', '1'); // a client script reacting
      this.inner = false;
    }
    return r;
  };
  rec._hook('g_form', form);
  form.setValue('category', 'software');
  const events = rec.events();
  assert.equal(events.length, 2);
  const [child, parent] = events; // children are stored first, the parent when its call returns
  assert.equal(parent.field, 'category');
  assert.equal(child.field, 'priority');
  assert.equal(child.parent, parent.id);
  assert.equal(child.depth, 1);
  assert.ok(parent.id < child.id, 'the parent started first');
  assert.ok(parent.seq > child.seq);
});

test('save and submit are recorded before the call, so a page that unloads still shows them', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  form.save = function () {
    assert.equal(rec.events().length, 1, 'the event is already stored when the original runs');
    return 'saved';
  };
  rec._hook('g_form', form);
  assert.equal(form.save(), 'saved');
  assert.equal(rec.events().length, 1);
  assert.equal(rec.events()[0].kind, 'form');
});

test('while not armed, wrapped methods are untouched pass-throughs and nothing is recorded', () => {
  const win = makeWindow();
  const rec = makeRecorder(win); // never started
  const form = newForm();
  const before = form.setValue;
  rec._hook('g_form', form);
  assert.equal(form.setValue, before, 'nothing is wrapped until armed');
  assert.equal(win._timers.size, 0, 'no timers');
  assert.equal(rec.events().length, 0);
  const armed = armedRecorder(makeWindow());
  const form2 = newForm();
  armed._hook('g_form', form2);
  armed.stop();
  assert.equal(form2.setValue('category', 'x'), 'set:category');
  assert.equal(armed.events().length, 0, 'after Disarm a wrapper only passes through');
});

test('wrapped methods keep their own toString and enumerability', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  const source = String(form.setValue);
  rec._hook('g_form', form);
  assert.equal(String(form.setValue), source);
  const proto = Object.getPrototypeOf(form);
  assert.equal(Object.getOwnPropertyDescriptor(proto, 'setValue').enumerable, false, 'a class method stays non-enumerable');
  const plain = { setValue() {} }; // an own, enumerable method (the usual shape for object literals) stays enumerable
  const other = createRecorder(makeWindow(), {});
  other.start(Date.now() + 60000);
  other._hook('g_form', plain);
  assert.equal(Object.getOwnPropertyDescriptor(plain, 'setValue').enumerable, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Ring buffer, pull, transport, arming
// ---------------------------------------------------------------------------------------------------------------------

test('the event ring keeps the newest events and counts what it dropped', () => {
  const win = makeWindow();
  const rec = armedRecorder(win, { maxEvents: 5 });
  const form = newForm();
  rec._hook('g_form', form);
  for (let i = 0; i < 12; i += 1) form.setValue('category', `v${i}`);
  const events = rec.events();
  assert.equal(events.length, 5);
  assert.deepEqual(events.map((e) => e.seq), [8, 9, 10, 11, 12]);
  const status = rec.status();
  assert.equal(status.dropped, 7);
  assert.equal(status.count, 5);
  assert.equal(status.lastSeq, 12);
});

test('the default cap is 1500 events', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  rec._hook('g_form', form);
  for (let i = 0; i < 1600; i += 1) form.addInfoMessage(`m${i}`);
  assert.equal(rec.events().length, LIMITS.events);
  assert.equal(rec.status().dropped, 100);
});

test('pull(since) returns only newer events, in order, with the last seq', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  rec._hook('g_form', form);
  form.setValue('category', 'a');
  form.setValue('category', 'b');
  const first = rec.pull(0);
  assert.equal(first.events.length, 2);
  assert.equal(first.rid, 'rid1');
  form.setValue('category', 'c');
  const second = rec.pull(first.lastSeq);
  assert.deepEqual(second.events.map((e) => e.args[0]), ['c']);
  assert.equal(rec.pull(second.lastSeq).events.length, 0);
  assert.equal(rec.pull(second.lastSeq).lastSeq, second.lastSeq);
  assert.equal(rec.pull('garbage').events.length, 3);
});

test('stack capture is skipped for floods of events (still recorded, no stack)', () => {
  const win = makeWindow();
  let captures = 0;
  const rec = armedRecorder(win, {
    captureStack: () => {
      captures += 1;
      return STACK;
    },
  });
  const form = newForm();
  rec._hook('g_form', form);
  for (let i = 0; i < 400; i += 1) form.addInfoMessage('x');
  assert.equal(captures, 300);
  assert.equal(rec.events().length, 400);
  assert.deepEqual(rec.events()[399].stack, []);
});

test('the DOM transport answers status, pull, clear, arm and disarm, and rejects what it does not know', () => {
  const win = makeWindow();
  const rec = makeRecorder(win);
  rec.attachTransport();
  const answers = [];
  win.document.addEventListener(RESPONSE_EVENT, (e) => answers.push(e.detail));
  const ask = (id, action, args) => {
    win.document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { id, action, args } }));
    return answers.find((a) => a.id === id);
  };
  assert.equal(ask('a', 'status').result.armed, false);
  const until = win._clock.epoch + 60_000;
  assert.equal(ask('b', 'arm', { until }).result.armed, true);
  const form = newForm();
  rec._hook('g_form', form);
  form.setValue('category', 'x');
  const pulled = ask('c', 'pull', { since: 0 });
  assert.equal(pulled.ok, true);
  assert.ok(pulled.result.events.some((e) => e.name === 'g_form.setValue'));
  assert.equal(ask('d', 'clear').result.count, 0);
  assert.equal(ask('e', 'disarm').result.armed, false);
  const bad = ask('f', 'eval', { code: '1+1' });
  assert.equal(bad.ok, false);
  // a request without an id, or with a non-object detail, gets no answer and does not throw
  win.document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: null }));
  win.document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { action: 'status' } }));
  assert.equal(answers.length, 6);
});

test('the arm flag: a future expiry arms, an expired or invalid value does not (and is removed)', () => {
  const win = makeWindow();
  const rec = makeRecorder(win);
  assert.equal(rec.readArmFlag(), 0);
  win.sessionStorage.setItem(ARM_KEY, String(win._clock.epoch + 1000));
  assert.equal(rec.readArmFlag(), win._clock.epoch + 1000);
  win.sessionStorage.setItem(ARM_KEY, String(win._clock.epoch - 1000));
  assert.equal(rec.readArmFlag(), 0);
  assert.equal(win.sessionStorage.getItem(ARM_KEY), null);
  win.sessionStorage.setItem(ARM_KEY, 'yes');
  assert.equal(rec.readArmFlag(), 0);
  win.sessionStorage.setItem(ARM_KEY, String(win._clock.epoch + 10 * ARM_DURATION_MS));
  assert.ok(rec.readArmFlag() <= win._clock.epoch + ARM_DURATION_MS + 60000, 'never longer than the 30 minute limit');
  win.sessionStorage.getItem = () => {
    throw new Error('blocked');
  };
  assert.equal(rec.readArmFlag(), 0);
});

test('recording stops by itself after 30 minutes and the flag is cleared', () => {
  const win = makeWindow();
  win.sessionStorage.setItem(ARM_KEY, String(win._clock.epoch + ARM_DURATION_MS));
  const rec = makeRecorder(win);
  rec.start(rec.readArmFlag());
  assert.equal(rec.isArmed(), true);
  win._clock.epoch += ARM_DURATION_MS + 1;
  win._timers.fireTimeouts();
  assert.equal(rec.isArmed(), false);
  assert.equal(win.sessionStorage.getItem(ARM_KEY), null);
  assert.equal(win._timers.size, 0, 'no timers left running');
});

test('another frame arming or disarming reaches this one through the storage event', () => {
  const win = makeWindow();
  const rec = makeRecorder(win);
  rec.attachTransport();
  win.sessionStorage.setItem(ARM_KEY, String(win._clock.epoch + 5000));
  win._fire('storage', { key: ARM_KEY });
  assert.equal(rec.isArmed(), true);
  win.sessionStorage.removeItem(ARM_KEY);
  win._fire('storage', { key: ARM_KEY });
  assert.equal(rec.isArmed(), false);
  win._fire('storage', { key: 'something_else' });
  assert.equal(rec.isArmed(), false);
});

test('boot does nothing off ServiceNow, and starts only when the tab is armed', () => {
  const off = makeWindow({ href: 'https://example.com/page' });
  assert.equal(boot(off), null);
  assert.equal(off._timers.size, 0);
  const idle = makeWindow();
  const rec = boot(idle);
  assert.ok(rec);
  assert.equal(rec.isArmed(), false);
  assert.equal(idle._timers.size, 0, 'not armed: no timers, no hooks');
  assert.equal(boot(idle), null, 'a second boot in the same window does nothing');
  const live = makeWindow();
  live.sessionStorage.setItem(ARM_KEY, String(Date.now() + 60_000)); // boot reads the real clock
  const armedRec = boot(live);
  assert.equal(armedRec.isArmed(), true);
  const forced = makeWindow({ href: 'http://localhost:4181/preview.html' });
  assert.ok(boot(forced, { allowAnyHost: true }));
});

test('frame label: top, or the frame name', () => {
  const win = makeWindow({ name: 'gsft_main' });
  assert.equal(makeRecorder(win).frame, 'gsft_main');
  const topWin = makeWindow({ name: '', top: 'self' });
  assert.equal(makeRecorder(topWin).frame, 'top');
  const anon = makeWindow({ name: '', top: {} });
  assert.equal(makeRecorder(anon).frame, 'frame');
});

// ---------------------------------------------------------------------------------------------------------------------
// GlideAjax, GlideRecord, modals
// ---------------------------------------------------------------------------------------------------------------------

test('GlideAjax: class, method and parameters are recorded; secrets are not; the callback still gets its arguments', () => {
  const FakeAjax = makeAjaxClass();
  const win = makeWindow();
  const rec = armedRecorder(win);
  rec._hook('GlideAjax', FakeAjax);
  FakeAjax.pending = [];
  const ga = new FakeAjax('x_acme.IncidentUtils');
  ga.addParam('sysparm_name', 'getDefaults');
  ga.addParam('sysparm_caller', 'abc123');
  ga.addParam('sysparm_api_key', 'AKIA-secret-value');
  ga.addParam('sysparm_ck', 'session-token');
  const seen = [];
  const THIS = {};
  const callback = function (response) {
    seen.push({ self: this, response });
    return 'cb-result';
  };
  win._clock.t = 100;
  const returned = ga.getXML(callback);
  assert.equal(returned, undefined);
  let [start] = rec.events();
  assert.equal(start.kind, 'ajax');
  assert.equal(start.phase, 'start');
  assert.equal(start.name, 'GlideAjax.getXML');
  assert.deepEqual(start.args, ['x_acme.IncidentUtils', 'getDefaults', { sysparm_caller: 'abc123', sysparm_api_key: HIDDEN }]);
  assert.equal(start.t, 100);
  win._clock.t = 740;
  const response = { status: 200, responseXML: { documentElement: { getAttribute: (n) => (n === 'answer' ? '{"ok":true}' : null) } } };
  assert.equal(FakeAjax.pending.pop().call(THIS, response), 'cb-result');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].self, THIS);
  assert.equal(seen[0].response, response);
  const [, end] = rec.events();
  assert.equal(end.phase, 'end');
  assert.equal(end.ref, start.id);
  assert.equal(end.durationMs, 640);
  assert.deepEqual(end.result, { status: 200, answer: '{"ok":true}' });
  assert.ok(!JSON.stringify(rec.events()).includes('AKIA-secret-value'));
  assert.ok(!JSON.stringify(rec.events()).includes('session-token'));
});

test('GlideAjax.getXMLWait is flagged as blocking, with its duration', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const Base = makeAjaxClass();
  class Sync extends Base {
    getXMLWait() {
      win._clock.t = 1210;
    }
  }
  rec._hook('GlideAjax', Sync);
  const ga = new Sync('Util');
  ga.addParam('sysparm_name', 'slow');
  win._clock.t = 10;
  ga.getXMLWait();
  const event = rec.events().pop();
  assert.equal(event.phase, undefined);
  assert.equal(event.flags.blocking, true);
  assert.equal(event.durationMs, 1200);
  assert.deepEqual(event.args.slice(0, 2), ['Util', 'slow']);
});

test('getXMLAnswer built on getXML is one call, not two; the answer is passed through', () => {
  const FakeAjax = makeAjaxClass();
  const win = makeWindow();
  const rec = armedRecorder(win);
  rec._hook('GlideAjax', FakeAjax);
  FakeAjax.pending = [];
  const ga = new FakeAjax('Util');
  ga.addParam('sysparm_name', 'answerMe');
  let got;
  ga.getXMLAnswer((answer) => {
    got = answer;
  });
  assert.equal(rec.events().length, 1);
  assert.equal(rec.events()[0].name, 'GlideAjax.getXMLAnswer');
  win._clock.t = 50;
  FakeAjax.pending.pop()({ answer: 'forty-two' });
  assert.equal(got, 'forty-two');
  assert.equal(rec.events()[1].result.answer, 'forty-two');
});

test('a GlideAjax whose original throws still throws, and is recorded as having thrown', () => {
  const FakeAjax = makeAjaxClass();
  const win = makeWindow();
  const rec = armedRecorder(win);
  class Broken extends FakeAjax {
    getXML() {
      throw new RangeError('no network');
    }
  }
  rec._hook('GlideAjax', Broken);
  const ga = new Broken('Util');
  assert.throws(() => ga.getXML(() => {}), /no network/);
  const [event] = rec.events();
  assert.equal(event.flags.threw, true);
});

test('GlideAjax without prototype initialize (class fields on the instance) still reports class and params', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  function Plain(cls) {
    this.processor = cls;
    this.params = { sysparm_name: 'direct', sysparm_user: 'u1', sysparm_password: 'pw' };
  }
  Plain.prototype.getXMLWait = function () {};
  rec._hook('GlideAjax', Plain);
  new Plain('Direct').getXMLWait();
  assert.deepEqual(rec.events()[0].args, ['Direct', 'direct', { sysparm_user: 'u1', sysparm_password: HIDDEN }]);
});

test('client GlideRecord: no callback blocks the browser, a callback does not; table and query are recorded', () => {
  const FakeGlideRecord = makeGlideRecordClass();
  const win = makeWindow();
  const rec = armedRecorder(win);
  rec._hook('GlideRecord', FakeGlideRecord);
  FakeGlideRecord.pending = [];
  const gr = new FakeGlideRecord('incident');
  gr.addQuery('active', 'true');
  assert.equal(gr.query(), 'queried');
  const gr2 = new FakeGlideRecord('sys_user');
  gr2.query(() => {});
  const [sync, async] = rec.events();
  assert.equal(sync.kind, 'glide');
  assert.equal(sync.name, 'GlideRecord.query');
  assert.deepEqual(sync.args, ['incident', 'active=true']);
  assert.equal(sync.flags.blocking, true);
  assert.equal(async.phase, 'start');
  assert.equal(async.flags, undefined);
  win._clock.t = 30;
  FakeGlideRecord.pending.pop()();
  assert.equal(rec.events()[2].phase, 'end');
});

test('GlideRecord.get does not double count the query it makes', () => {
  const FakeGlideRecord = makeGlideRecordClass();
  const win = makeWindow();
  const rec = armedRecorder(win);
  rec._hook('GlideRecord', FakeGlideRecord);
  new FakeGlideRecord('incident').get('abc');
  assert.equal(rec.events().length, 1);
  assert.equal(rec.events()[0].name, 'GlideRecord.get');
});

test('GlideModal.render and g_modal calls are recorded with their title', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  class GlideModal {
    constructor(id) {
      this.id = id;
      this.title = 'Pick one';
    }
    render() {
      return 'rendered';
    }
  }
  rec._hook('GlideModal', GlideModal);
  assert.equal(new GlideModal('m1').render(), 'rendered');
  const gModal = { showFrame: (opts) => `frame:${opts.title}` };
  rec._hook('g_modal', gModal);
  assert.equal(gModal.showFrame({ title: 'Details', url: '/x.do' }), 'frame:Details');
  const [a, b] = rec.events();
  assert.equal(a.kind, 'modal');
  assert.deepEqual(a.args, ['Pick one']);
  assert.deepEqual(b.args, ['Details']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Late globals
// ---------------------------------------------------------------------------------------------------------------------

test('g_form assigned after arming is hooked the moment it is assigned, and stays a plain property', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  assert.equal(win.g_form, undefined);
  const form = newForm();
  win.g_form = form; // what the page does
  const desc = Object.getOwnPropertyDescriptor(win, 'g_form');
  assert.equal(desc.value, form, 'back to a plain data property');
  assert.equal(desc.writable, true);
  form.setValue('category', 'late');
  assert.equal(rec.events().length, 1);
  // a second form instance assigned later is hooked as well
  const form2 = newForm();
  win.g_form = form2; // a plain property now: the poll finds it
  win._timers.tickIntervals(1);
  form2.setValue('category', 'later');
  assert.equal(rec.events().length, 2);
});

test('globals that were already there at arm time are hooked immediately', () => {
  const FakeAjax = makeAjaxClass();
  const win = makeWindow();
  win.g_form = newForm();
  win.GlideAjax = FakeAjax;
  const rec = armedRecorder(win);
  win.g_form.setValue('category', 'x');
  assert.equal(rec.events().length, 1);
  assert.equal(rec.status().installed.GlideAjax, true);
});

test('a global the trap could not see (declared over it) is found by the bounded poll', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  Object.defineProperty(win, 'g_form', { value: form, writable: true, configurable: true }); // replaces the accessor without calling the setter
  form.setValue('category', 'x');
  assert.equal(rec.events().length, 0, 'not seen yet');
  win._timers.tickIntervals(1);
  form.setValue('category', 'y');
  assert.equal(rec.events().length, 1);
});

test('the poll is bounded: it ends on its own', () => {
  const win = makeWindow();
  armedRecorder(win);
  assert.ok(win._timers.intervals() >= 1);
  for (let i = 0; i < 400; i += 1) win._timers.tickIntervals(1);
  assert.equal(win._timers.intervals(), 0);
});

test('stopping removes a trap that was never triggered: the global is absent again, as before arming', () => {
  const win = makeWindow();
  assert.equal('g_form' in win, false);
  const rec = armedRecorder(win);
  assert.ok(Object.getOwnPropertyDescriptor(win, 'g_form').set, 'trap in place while recording');
  rec.stop();
  assert.equal(Object.getOwnPropertyDescriptor(win, 'g_form'), undefined);
  assert.equal('g_form' in win, false, '`name in window` checks see what they saw before');
  // a global that existed (with no value yet) keeps existing, as a plain data property with its own enumerability
  const win2 = makeWindow();
  Object.defineProperty(win2, 'GlideAjax', { value: null, writable: true, enumerable: false, configurable: true });
  const rec2 = armedRecorder(win2);
  rec2.stop();
  const desc = Object.getOwnPropertyDescriptor(win2, 'GlideAjax');
  assert.ok(desc && !desc.set && 'value' in desc);
  assert.equal(desc.enumerable, false);
});

test('a non-configurable global cannot be trapped, and arming still works', () => {
  const win = makeWindow();
  Object.defineProperty(win, 'g_form', { value: undefined, writable: true, configurable: false });
  const rec = armedRecorder(win);
  assert.equal(rec.isArmed(), true);
  const form = newForm();
  win.g_form = form;
  win._timers.tickIntervals(1);
  form.setValue('category', 'x');
  assert.equal(rec.events().length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// console, errors, network
// ---------------------------------------------------------------------------------------------------------------------

test('console.error and console.warn are recorded and still reach the original with the same arguments', () => {
  const win = makeWindow();
  const calls = [];
  win.console.error = function (...args) {
    calls.push({ self: this, args });
  };
  const original = win.console.error;
  const rec = armedRecorder(win);
  assert.notEqual(win.console.error, original);
  win.console.error('Script failed', { code: 7 }, 'password=hunter2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].self, win.console);
  assert.deepEqual(calls[0].args, ['Script failed', { code: 7 }, 'password=hunter2'], 'the page sees its own arguments');
  const [event] = rec.events();
  assert.equal(event.kind, 'console');
  assert.equal(event.name, 'console.error');
  assert.ok(!JSON.stringify(event).includes('hunter2'));
  win.console.warn('careful');
  assert.equal(rec.events()[1].name, 'console.warn');
  rec.stop();
  assert.equal(win.console.error, original, 'Disarm puts the original console back');
});

test('console restore leaves a wrapper someone else put on top', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const ours = win.console.error;
  const theirs = function (...a) {
    return ours.apply(this, a);
  };
  win.console.error = theirs;
  rec.stop();
  assert.equal(win.console.error, theirs);
});

test('uncaught errors and unhandled rejections are recorded with a parsed stack', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const error = new TypeError('x is undefined');
  error.stack = 'TypeError: x is undefined\n    at onLoad_aa (https://dev1.service-now.com/incident.do?sys_id=1:30:9)';
  win._fire('error', { message: 'Uncaught TypeError: x is undefined', error, filename: 'https://dev1.service-now.com/incident.do', lineno: 30, colno: 9 });
  win._fire('error', { target: { tagName: 'IMG' }, message: undefined }); // a resource error: not ours
  win._fire('unhandledrejection', { reason: new Error('promise failed') });
  win._fire('unhandledrejection', { reason: 'plain string' });
  const events = rec.events();
  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'error');
  assert.equal(events[0].name, 'TypeError');
  assert.equal(events[0].flags.exception, true);
  assert.deepEqual(events[0].stack, [{ fn: 'onLoad_aa', line: 30, col: 9, url: '/incident.do' }]);
  assert.equal(events[1].name, 'Unhandled promise rejection');
  assert.match(events[1].args[0], /promise failed/);
  assert.match(events[2].args[0], /plain string/);
});

test('an error with no stack still names the file and line', () => {
  const FakeXhr = makeXhrClass();
  const win = makeWindow();
  const rec = armedRecorder(win);
  win._fire('error', { message: 'Script error.', error: null, filename: 'https://dev1.service-now.com/x.js', lineno: 4, colno: 2 });
  assert.deepEqual(rec.events()[0].stack, [{ fn: '', line: 4, col: 2, url: '/x.js' }]);
});

const makeXhrClass = () =>
  class FakeXhr {
  constructor() {
    this.listeners = {};
    this.status = 0;
  }
  open(method, url, async = true) {
    this.m = method;
    this.u = url;
    this.async = async;
  }
  send(body) {
    this.sent = body;
    if (this.async === false) this.status = 200;
    return 'sent';
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  finish(status) {
    this.status = status;
    (this.listeners.loadend || []).forEach((fn) => fn());
  }
};

test('XHR to ServiceNow endpoints is recorded with status and duration; other requests are ignored', () => {
  const FakeXhr = makeXhrClass();
  const win = makeWindow();
  win.XMLHttpRequest = FakeXhr;
  const originalOpen = FakeXhr.prototype.open;
  const rec = armedRecorder(win);
  assert.notEqual(FakeXhr.prototype.open, originalOpen);
  const x = new FakeXhr();
  x.open('get', '/api/now/table/incident?sysparm_limit=5&sysparm_ck=tok123&password=pw');
  win._clock.t = 10;
  assert.equal(x.send(null), 'sent');
  win._clock.t = 260;
  x.finish(200);
  const other = new FakeXhr();
  other.open('GET', '/images/logo.png');
  other.send();
  const cross = new FakeXhr();
  cross.open('GET', 'https://elsewhere.example.com/api/now/table/x');
  cross.send();
  const [event] = rec.events();
  assert.equal(rec.events().length, 1);
  assert.equal(event.kind, 'network');
  assert.equal(event.name, 'GET /api/now/table/incident');
  assert.equal(event.durationMs, 250);
  assert.deepEqual(event.result, { status: 200 });
  assert.ok(!JSON.stringify(event).includes('tok123'));
  assert.ok(!JSON.stringify(event).includes('=pw'));
  rec.stop();
  assert.equal(FakeXhr.prototype.open, originalOpen, 'Disarm restores XHR');
});

test('a failing request is flagged; a synchronous one is flagged as blocking; the send result and errors pass through', () => {
  const FakeXhr = makeXhrClass();
  const win = makeWindow();
  win.XMLHttpRequest = FakeXhr;
  const rec = armedRecorder(win);
  const a = new FakeXhr();
  a.open('POST', '/xmlhttp.do');
  a.send('sysparm_processor=Util&sysparm_name=getIt&sysparm_ck=zzz');
  a.finish(500);
  const b = new FakeXhr();
  b.open('GET', '/api/now/stats/incident', false);
  assert.equal(b.send(), 'sent');
  const c = new FakeXhr();
  c.open('GET', '/api/now/table/x');
  c.send = function () {
    throw new Error('InvalidStateError');
  };
  FakeXhr.prototype.send.call(c);
  const events = rec.events();
  assert.equal(events[0].name, 'POST /xmlhttp.do Util.getIt');
  assert.equal(events[0].flags.failed, true);
  assert.ok(!JSON.stringify(events).includes('zzz'));
  assert.equal(events[1].flags.blocking, true);
});

test('an aborted XHR is recorded as cancelled, not failed', () => {
  const win = makeWindow();
  const FakeXhr = makeXhrClass();
  win.XMLHttpRequest = FakeXhr;
  const rec = armedRecorder(win);
  const x = new FakeXhr();
  x.open('GET', '/api/now/table/incident?sysparm_query=typeahead');
  x.send();
  (x.listeners.abort || []).forEach((fn) => fn());
  x.finish(0);
  const [event] = rec.events();
  assert.deepEqual(event.result, { status: 0, aborted: true });
  assert.equal(event.flags, undefined);
});

test('XHR made inside a GlideAjax call is not recorded a second time', () => {
  const FakeAjax = makeAjaxClass();
  const FakeXhr = makeXhrClass();
  const win = makeWindow();
  win.XMLHttpRequest = FakeXhr;
  const rec = armedRecorder(win);
  class Ajax extends FakeAjax {
    getXML(cb) {
      const x = new FakeXhr();
      x.open('POST', '/xmlhttp.do');
      x.send('sysparm_processor=Util');
      FakeAjax.pending.push(cb);
    }
  }
  rec._hook('GlideAjax', Ajax);
  const ga = new Ajax('Util');
  ga.addParam('sysparm_name', 'once');
  ga.getXML(() => {});
  assert.equal(rec.events().length, 1);
  assert.equal(rec.events()[0].kind, 'ajax');
});

test('fetch to ServiceNow is recorded; the response and the rejection reach the page unchanged', async () => {
  const win = makeWindow();
  const response = { status: 200, marker: 'same object' };
  let mode = 'ok';
  win.fetch = function () {
    if (mode === 'offline') return Promise.reject(new Error('offline'));
    if (mode === 'abort') return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    return Promise.resolve(response);
  };
  const original = win.fetch;
  const rec = armedRecorder(win);
  assert.notEqual(win.fetch, original);
  assert.equal(await win.fetch('/api/now/table/incident?sysparm_limit=1'), response);
  assert.equal(await win.fetch('/somewhere/else'), response);
  mode = 'offline';
  await assert.rejects(() => win.fetch('/api/now/table/x', { method: 'post' }), /offline/);
  mode = 'abort';
  await assert.rejects(() => win.fetch('/api/now/table/typeahead'), (err) => err.name === 'AbortError');
  const events = rec.events();
  assert.equal(events.length, 3);
  assert.equal(events[0].name, 'fetch GET /api/now/table/incident');
  assert.deepEqual(events[0].result, { status: 200 });
  assert.equal(events[1].name, 'fetch POST /api/now/table/x');
  assert.equal(events[1].flags.failed, true);
  assert.equal(events[2].flags, undefined, 'a request the page aborted is not a failure');
  assert.equal(events[2].result.aborted, true);
  rec.stop();
  assert.equal(win.fetch, original);
});

test('long tasks of 100 ms or more are recorded (and capped)', () => {
  const win = makeWindow();
  let callback;
  win.PerformanceObserver = class {
    constructor(cb) {
      callback = cb;
    }
    observe() {}
    disconnect() {}
  };
  const rec = armedRecorder(win);
  callback({ getEntries: () => [{ duration: 40, startTime: 5 }, { duration: 850, startTime: 1200 }] });
  const events = rec.events().filter((e) => e.kind === 'longtask');
  assert.equal(events.length, 1);
  assert.equal(events[0].durationMs, 850);
  assert.equal(events[0].t, 1200);
});

test('page markers: start, and DOMContentLoaded / load while the page is loading', () => {
  const win = makeWindow();
  win.document.readyState = 'loading';
  const rec = armedRecorder(win, { pageMarkers: true });
  win.document.dispatchEvent(new Event('DOMContentLoaded'));
  win._fire('load');
  const names = rec.events().map((e) => e.name);
  assert.deepEqual(names, ['page load started', 'DOMContentLoaded', 'load']);
  assert.deepEqual(rec.events()[0].args, ['/incident.do', 'loading']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Adversarial: secrets under innocent names, hostile values, wrappers on top of ours, the page fighting the transport
// ---------------------------------------------------------------------------------------------------------------------

/** A page with password inputs: `inputs` is the live list document.querySelectorAll('input[type="password"]') returns. */
function withPasswordInputs(win, values) {
  const inputs = values.map((value) => ({ type: 'password', value }));
  win.document.querySelectorAll = (sel) => (sel === 'input[type="password"]' ? inputs : []);
  return inputs;
}

test('a value typed into a password input is never recorded, whatever it is called or wherever a script copies it', () => {
  const FakeAjax = makeAjaxClass();
  const win = makeWindow();
  const inputs = withPasswordInputs(win, ['S3cret!pw']);
  const rec = armedRecorder(win);
  const form = newForm();
  form.values.u_notes = '';
  rec._hook('g_form', form);
  rec._hook('GlideAjax', FakeAjax);
  const ga = new FakeAjax('PasswordUtils');
  ga.addParam('sysparm_name', 'reset');
  ga.addParam('sysparm_value', 'S3cret!pw'); // an innocent parameter name
  ga.getXMLWait();
  form.setValue('u_notes', 'copied S3cret!pw here'); // copied into an ordinary field
  win.console.error('debug: pw is S3cret!pw');
  let dump = JSON.stringify(rec.events());
  assert.ok(!dump.includes('S3cret!pw'), dump);
  const field = rec.events().find((e) => e.name === 'g_form.setValue');
  assert.equal(field.flags.hidden, true, 'the field story then says "value not recorded"');
  assert.equal(trace.verbFor(field), 'set (value not recorded)');
  assert.deepEqual(rec.events()[0].args.slice(0, 2), ['PasswordUtils', 'reset'], 'class and method are still shown');
  // a script sets a new value with no event at all: values are read fresh for every event
  inputs[0].value = 'N3wPassw0rd';
  win.console.warn('now N3wPassw0rd');
  // a password input that appears later (a dialog) is found as soon as it fires an input event
  inputs.push({ type: 'password', value: 'Dialog-pw-77' });
  win.document.type = 'password'; // the fake event's target is the document itself
  win.document.dispatchEvent(new Event('input'));
  delete win.document.type;
  win.console.warn('dialog Dialog-pw-77');
  dump = JSON.stringify(rec.events());
  assert.ok(!dump.includes('N3wPassw0rd'), dump);
  assert.ok(!dump.includes('Dialog-pw-77'), dump);
  // ordinary text is untouched
  win.console.warn('nothing secret here');
  assert.ok(JSON.stringify(rec.events()).includes('nothing secret here'));
});

test('text in g_form messages, values, GlideAjax answers and errors loses password=..., tokens and Bearer values', () => {
  const FakeAjax = makeAjaxClass();
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  form.addErrorMessage = function () {};
  rec._hook('g_form', form);
  rec._hook('GlideAjax', FakeAjax);
  FakeAjax.pending = [];
  form.addInfoMessage('Your password=hunter2 was reset');
  form.addErrorMessage({ client_secret_value: 'shh-123', note: 'ok' });
  form.setValue('short_description', 'call with Authorization: Bearer abcdefghijklmnop1234');
  win.console.error('header Bearer zyxwvutsrqponm9876 sent');
  const ga = new FakeAjax('TokenUtils');
  ga.addParam('sysparm_name', 'issue');
  ga.getXMLAnswer(() => {});
  FakeAjax.pending.pop()({ answer: '{"token":"tok-abc-123","ok":true}' });
  const boom = new Error('login failed: password=pw-xyz');
  const form2 = newForm();
  form2.addInfoMessage = function () {
    throw boom;
  };
  rec._hook('g_form', form2);
  assert.throws(() => form2.addInfoMessage('x'), (e) => e === boom);
  assert.equal(rec.events().pop().flags.threw, true, 'the throw was recorded');
  const dump = JSON.stringify(rec.events());
  ['hunter2', 'shh-123', 'abcdefghijklmnop1234', 'zyxwvutsrqponm9876', 'tok-abc-123', 'pw-xyz'].forEach((s) => assert.ok(!dump.includes(s), `${s} must not be stored: ${dump}`));
  assert.ok(dump.includes('was reset') && dump.includes('ok'), 'the rest of the text stays');
});

test('encoded queries: the value of a secret-named field is hidden whatever the operator, other conditions stay', () => {
  const { scrubQuery } = require('../src/lib/clientTraceRecorder.js');
  const q = 'active=true^u_secret_value=abc^u_password!=def^ORu_tokenLIKEghi^u_api_keySTARTSWITHjkl^u_pinINmno^u_passwordLIKEUPPERCASE^NQcategory=x^ORDERBYu_password';
  const out = scrubQuery(q);
  ['abc', 'def', 'ghi', 'jkl', 'mno', 'UPPERCASE'].forEach((s) => assert.ok(!out.includes(s), `${s} in ${out}`));
  assert.ok(out.startsWith('active=true^u_secret_value=[hidden]^u_password!=[hidden]^ORu_tokenLIKE[hidden]'), out);
  assert.ok(out.includes('NQcategory=x') && out.endsWith('ORDERBYu_password'));
  assert.equal(scrubQuery('plain text, not a query'), 'plain text, not a query');
  // through client GlideRecord
  const FakeGlideRecord = makeGlideRecordClass();
  const win = makeWindow();
  const rec = armedRecorder(win);
  rec._hook('GlideRecord', FakeGlideRecord);
  const gr = new FakeGlideRecord('sys_user');
  gr.q = 'active=true^u_password_hash=deadbeef^';
  gr.query();
  assert.ok(!JSON.stringify(rec.events()).includes('deadbeef'));
  assert.match(rec.events()[0].args[1], /^active=true\^u_password_hash=\[hidden\]/);
});

test('request urls: an encoded secret condition inside sysparm_query is hidden too (checked decoded)', () => {
  const FakeXhr = makeXhrClass();
  const win = makeWindow();
  win.XMLHttpRequest = FakeXhr;
  const rec = armedRecorder(win);
  const x = new FakeXhr();
  x.open('GET', '/api/now/table/sys_user?sysparm_query=active%3Dtrue%5Eu_password%3Dhunter2&sysparm_limit=1&sysparm_note=Bearer%20abcdefghijklmnop12');
  x.send();
  x.finish(200);
  const [event] = rec.events();
  const dump = JSON.stringify(event);
  assert.ok(!dump.includes('hunter2'), dump);
  assert.ok(!dump.includes('abcdefghijklmnop12'), dump);
  assert.match(event.args[0], /sysparm_query=active=true\^u_password=\[hidden\]/);
  assert.match(event.args[0], /sysparm_limit=1/);
});

test('summaries of hostile values: huge typed arrays, throwing proxies, revoked proxies, frozen and cyclic objects, secret keys', () => {
  const huge = new Uint8Array(20_000_000);
  let t = Date.now();
  assert.equal(summarize(huge), '[binary]');
  assert.equal(summarize({ data: huge }), '{data: [binary]}');
  assert.ok(Date.now() - t < 200, 'no work proportional to the array');
  const trap = () => {
    throw new Error('trap ran');
  };
  const hostile = new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap, getPrototypeOf: trap });
  assert.doesNotThrow(() => summarize(hostile));
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(summarize(proxy), '[unreadable]');
  const cyclic = [1];
  cyclic.push(cyclic);
  assert.doesNotThrow(() => summarize(cyclic));
  assert.equal(summarize(Object.freeze({ a: 1 })), '{a: 1}');
  const noisy = {
    toString() {
      throw new Error('toString ran');
    },
    valueOf() {
      throw new Error('valueOf ran');
    },
  };
  assert.doesNotThrow(() => summarize(noisy));
  assert.equal(summarize({ api_key: 'k-123', session_id: 's-1', name: 'x' }), '{api_key: [hidden], session_id: [hidden], name: "x"}');
  assert.equal(summarize({ jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r' }), '{jwt: "[hidden]"}');
  t = Date.now();
  const long = `${'a'.repeat(5_000_000)} password=x`;
  assert.equal(summarize(long).length, LIMITS.text);
  assert.ok(Date.now() - t < 200, 'a huge string costs no more than a short one');
});

test('wrapper transparency: arity, enumeration, instanceof, Promise results, frozen and sealed objects', async () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const Form = makeFormClass();
  const form = new Form();
  const promise = Promise.resolve('done');
  form.addInfoMessage = () => promise; // an own (enumerable) method that returns a Promise
  const keysBefore = [];
  for (const k in form) keysBefore.push(k); // eslint-disable-line guard-for-in
  const lengthBefore = form.setValue.length;
  rec._hook('g_form', form);
  const keysAfter = [];
  for (const k in form) keysAfter.push(k); // eslint-disable-line guard-for-in
  assert.deepEqual(keysAfter, keysBefore);
  assert.equal(form.setValue.length, lengthBefore);
  assert.ok(form instanceof Form);
  assert.equal(form.addInfoMessage('x'), promise, 'the very same Promise comes back');
  assert.equal(await form.addInfoMessage('y'), 'done');
  // frozen: nothing can be wrapped, nothing breaks
  const frozen = Object.freeze({ setValue: () => 'frozen-ok', hasField: () => true });
  rec._hook('g_form', frozen);
  assert.equal(frozen.setValue('a', 'b'), 'frozen-ok');
  // sealed (non-configurable but writable): wrapped, still works, still sealed
  const sealed = Object.seal({ setValue: (f, v) => `sealed:${v}`, hasField: () => true });
  rec._hook('g_form', sealed);
  assert.equal(sealed.setValue('a', 'b'), 'sealed:b');
  assert.ok(Object.isSealed(sealed));
  assert.equal(rec.events().filter((e) => e.name === 'g_form.setValue').length, 1, 'only the sealed one could be recorded');
  // a g_form missing most methods: hooked without errors
  assert.doesNotThrow(() => rec._hook('g_form', { getValue() {} }));
});

test('a Prototype-style subclass that calls its parent is one recorded call, and the parent still runs once', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  let parentRuns = 0;
  function Base() {}
  Base.prototype.setValue = function (f, v) {
    parentRuns += 1;
    return `base:${v}`;
  };
  Base.prototype.hasField = () => true;
  function Catalog() {}
  Catalog.prototype = Object.create(Base.prototype);
  // Prototype's Class.create resolves $super at call time: ancestor[m].apply(this, arguments)
  Catalog.prototype.setValue = function () {
    return Base.prototype.setValue.apply(this, arguments);
  };
  const form = new Catalog();
  rec._hook('g_form', form);
  rec._hook('g_form', new Base()); // another form on the page, built from the parent class: wraps Base.prototype too
  assert.equal(form.setValue('category', 'x'), 'base:x');
  assert.equal(parentRuns, 1);
  assert.equal(rec.events().length, 1, 'the identical inner call is the platform calling itself');
});

test('a getValue that cannot be read is not reported as "it already had that value"', () => {
  const win = makeWindow();
  const rec = armedRecorder(win);
  const form = newForm();
  form.getValue = () => {
    throw new Error('not readable');
  };
  rec._hook('g_form', form);
  form.setValue('category', 'network');
  const [event] = rec.events();
  assert.equal(event.result?.changed, undefined);
  assert.equal(trace.verbFor(event), 'set to "network"');
});

test('re-arming after a page wrapped XHR, fetch and console on top of ours records each call once, not twice', async () => {
  const FakeXhr = makeXhrClass();
  const win = makeWindow();
  win.XMLHttpRequest = FakeXhr;
  win.fetch = () => Promise.resolve({ status: 200 });
  const rec = armedRecorder(win);
  // a monitoring script loads later and wraps everything on top of ours
  const ourOpen = FakeXhr.prototype.open;
  const ourSend = FakeXhr.prototype.send;
  FakeXhr.prototype.open = function () {
    return ourOpen.apply(this, arguments);
  };
  FakeXhr.prototype.send = function () {
    return ourSend.apply(this, arguments);
  };
  const ourFetch = win.fetch;
  win.fetch = function () {
    return ourFetch.apply(this, arguments);
  };
  const ourError = win.console.error;
  win.console.error = function () {
    return ourError.apply(this, arguments);
  };
  rec.stop(); // cannot take ours out from under theirs
  rec.start(win._clock.epoch + 60_000);
  const x = new FakeXhr();
  x.open('GET', '/api/now/table/incident');
  x.send();
  x.finish(200);
  await win.fetch('/api/now/table/problem');
  win.console.error('once');
  const names = rec.events().map((e) => e.name);
  assert.equal(names.filter((n) => n === 'GET /api/now/table/incident').length, 1, names.join(','));
  assert.equal(names.filter((n) => n === 'fetch GET /api/now/table/problem').length, 1, names.join(','));
  assert.equal(names.filter((n) => n === 'console.error').length, 1, names.join(','));
});

test('back from the back/forward cache after the 30 minutes: recording stops and the flag goes', () => {
  const win = makeWindow();
  const rec = makeRecorder(win);
  rec.attachTransport();
  win.sessionStorage.setItem(ARM_KEY, String(win._clock.epoch + ARM_DURATION_MS));
  rec.start(rec.readArmFlag());
  win._clock.epoch += ARM_DURATION_MS + 5 * 60_000; // frozen in the cache, timers did not fire
  win._fire('pageshow', { persisted: true });
  assert.equal(rec.isArmed(), false);
  assert.equal(win.sessionStorage.getItem(ARM_KEY), null);
  // and a page restored while another page of the tab armed it starts recording
  win.sessionStorage.setItem(ARM_KEY, String(win._clock.epoch + 60_000));
  win._fire('pageshow', { persisted: true });
  assert.equal(rec.isArmed(), true);
});

test('the frame label is capped (window.name can be megabytes)', () => {
  const win = makeWindow({ name: 'n'.repeat(1_000_000) });
  assert.ok(makeRecorder(win).frame.length <= 60);
});

test("a page's Error.prepareStackTrace that calls g_form does not make the recorder recurse", () => {
  const win = makeWindow();
  const form = newForm();
  let depth = 0;
  class PageError {
    static stackTraceLimit = 10;
    get stack() {
      depth += 1;
      if (depth < 50) form.setValue('priority', String(depth)); // what a hostile prepareStackTrace could do
      return 'Error\n    at onLoad_x (https://dev1.service-now.com/incident.do:5:7)';
    }
  }
  win.Error = PageError;
  const rec = armedRecorder(win, { captureStack: undefined });
  rec._hook('g_form', form);
  assert.equal(form.setValue('category', 'x'), 'set:category');
  assert.ok(depth < 5, `stack read ${depth} times`);
  assert.equal(PageError.stackTraceLimit, 10, 'the page value is put back');
});

test('the transport keeps answering when the page replaces window.CustomEvent and dispatchEvent later', () => {
  const win = makeWindow();
  const rec = makeRecorder(win);
  rec.attachTransport();
  const answers = [];
  win.document.addEventListener(RESPONSE_EVENT, (e) => answers.push(e.detail));
  win.CustomEvent = function Broken() {
    throw new Error('polyfill gone wrong');
  };
  const realDispatch = EventTarget.prototype.dispatchEvent;
  win.document.dispatchEvent = () => false; // own property, shadows the prototype
  realDispatch.call(win.document, new CustomEvent(REQUEST_EVENT, { detail: { id: 'q1', action: 'status' } }));
  assert.equal(answers.length, 1);
  assert.equal(answers[0].result.rid, 'rid1');
});

// ---------------------------------------------------------------------------------------------------------------------
// Analysis: rows, attribution, stories, findings, filters, Markdown
// ---------------------------------------------------------------------------------------------------------------------

const ID_CS = '6816f79cc0a8016401c5a33be04be441';
const ID_CS2 = '287ebd7da9fe198100f92cc8d1d2154e';
const frameFor = (id, fn = 'onChange') => [{ fn: `${fn}_${id}`, line: 1, col: 1, url: '/incident.do' }];
let nextSeq = 0;
const ev = (over) => ({ seq: (nextSeq += 1), id: nextSeq, rid: 'r1', t: 0, at: 1_700_000_000_000, kind: 'field', name: 'g_form.setValue', frame: 'gsft_main', stack: [], ...over });

const RESOLVED = {
  ids: {
    [ID_CS]: { table: 'sys_script_client', kind: 'Client script', name: 'Set defaults', type: 'onLoad' },
    [ID_CS2]: { table: 'sys_script_client', kind: 'Client script', name: 'Reset on category', type: 'onChange', field: 'category' },
  },
  names: { my_lib: { table: 'sys_ui_script', kind: 'UI script', name: 'my_lib' } },
  classes: {},
};

test('rows: a call and its end event become one row with a duration; a start with no end is pending; duplicates are dropped', () => {
  const start = ev({ kind: 'ajax', name: 'GlideAjax.getXML', phase: 'start', args: ['U', 'm', {}], t: 100, at: 1_700_000_000_100 });
  const end = ev({ kind: 'ajax', name: 'GlideAjax.getXML', phase: 'end', ref: start.id, durationMs: 640, t: 740, at: 1_700_000_000_740, result: { status: 200 } });
  const open = ev({ kind: 'ajax', name: 'GlideAjax.getXML', phase: 'start', args: ['U', 'n', {}], t: 800, at: 1_700_000_000_800 });
  const orphan = ev({ kind: 'ajax', name: 'GlideAjax.getXML', phase: 'end', ref: 9999, durationMs: 5, t: 900, at: 1_700_000_000_900 });
  const rows = trace.buildRows([end, open, start, start, orphan, null, { kind: 'nope' }]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].pending, false);
  assert.equal(rows[0].durationMs, 640);
  assert.equal(rows[0].result.status, 200);
  assert.equal(rows[1].pending, true);
  assert.equal(rows[2].orphan, true);
});

test('one stall seen by the shell and the form frame is listed once, under the form frame', () => {
  const rows = trace.buildRows([
    ev({ rid: 'top1', frame: 'top', kind: 'longtask', name: 'Long task', durationMs: 374, t: 90, at: 1_700_000_000_090 }),
    ev({ rid: 'form', frame: 'gsft_main', kind: 'longtask', name: 'Long task', durationMs: 372, t: 48, at: 1_700_000_000_070 }),
    ev({ rid: 'form', frame: 'gsft_main', kind: 'longtask', name: 'Long task', durationMs: 900, t: 2000, at: 1_700_000_002_000 }),
    ev({ rid: 'top1', frame: 'top', kind: 'longtask', name: 'Long task', durationMs: 900, t: 2040, at: 1_700_000_002_020 }),
    ev({ rid: 'top1', frame: 'top', kind: 'longtask', name: 'Long task', durationMs: 300, t: 5000, at: 1_700_000_005_000 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.frame + ':' + r.durationMs),
    ['gsft_main:372', 'gsft_main:900', 'top:300']
  );
});

test('attribution: a confirmed sys_id in a function name names the script; nothing else ever does', () => {
  const known = trace.attribute(ev({ stack: [{ fn: 'x', line: 1, col: 1 }, ...frameFor(ID_CS, 'onLoad')] }), RESOLVED);
  assert.equal(known.known, true);
  assert.equal(known.label, 'Client script: Set defaults (onLoad)');
  const change = trace.attribute(ev({ stack: frameFor(ID_CS2) }), RESOLVED);
  assert.equal(change.label, 'Client script: Reset on category (onChange on category)');
  const ui = trace.attribute(ev({ stack: [{ fn: 'f', line: 3, col: 4, url: '/scripts/my_lib.jsdbx' }] }), RESOLVED);
  assert.equal(ui.label, 'UI script: my_lib');
  // an id that was not confirmed on the instance is not a name
  const unconfirmed = trace.attribute(ev({ stack: frameFor('0123456789abcdef0123456789abcdef') }), RESOLVED);
  assert.equal(unconfirmed.known, false);
  assert.equal(unconfirmed.label, 'Unknown script');
  assert.match(unconfirmed.where, /onChange_0123456789abcdef0123456789abcdef at \/incident\.do:1:1/);
  const none = trace.attribute(ev({ stack: [] }), RESOLVED);
  assert.equal(none.label, 'Unknown script');
  assert.equal(none.where, 'no stack was captured');
  // the record's own sys_id in a url QUERY is not a candidate
  assert.deepEqual(trace.collectRefs([ev({ stack: [{ fn: 'f', line: 1, col: 1, url: '/incident.do' }] })]).ids, []);
});

test('refs to resolve: ids from function names, UI script names from .jsdbx urls, GlideAjax classes', () => {
  const rows = [
    ev({ stack: [{ fn: `onChange_${ID_CS}`, line: 1, col: 1, url: '/incident.do' }, { fn: 'g', line: 2, col: 2, url: '/scripts/my_lib.jsdbx' }, { fn: 'h', line: 1, col: 1, url: '/scripts/js_includes.jsx' }] }),
    ev({ kind: 'ajax', name: 'GlideAjax.getXML', args: ['IncidentUtils', 'm', {}], stack: [] }),
    ev({ stack: frameFor(ID_CS.toUpperCase()) }),
  ];
  const refs = trace.collectRefs(rows);
  assert.deepEqual(refs.ids, [ID_CS]);
  assert.deepEqual(refs.names, ['my_lib']);
  assert.deepEqual(refs.classes, ['IncidentUtils']);
});

test('the lookup tables are the ones the brief names, base tables before their catalog subclasses', () => {
  const tables = trace.RESOLVE_TABLES.map((t) => t.table);
  ['sys_script_client', 'sys_ui_policy', 'sys_ui_action', 'sys_ui_script', 'catalog_script_client'].forEach((t) => assert.ok(tables.includes(t), t));
  assert.ok(tables.indexOf('sys_script_client') < tables.indexOf('catalog_script_client'));
  assert.ok(tables.indexOf('sys_ui_policy') < tables.indexOf('catalog_ui_policy'));
});

function storyRows() {
  return trace.buildRows([
    ev({ kind: 'page', name: 'page load started', args: ['/incident.do', 'loading'], t: 0, at: 1_700_000_000_000 }),
    ev({ field: 'short_description', args: ['Printer broken'], result: { before: '', after: 'Printer broken', changed: true }, t: 120, at: 1_700_000_000_120, stack: frameFor(ID_CS, 'onLoad') }),
    ev({ name: 'g_form.setMandatory', field: 'short_description', args: [true], t: 200, at: 1_700_000_000_200, stack: frameFor(ID_CS, 'onLoad') }),
    ev({ name: 'g_form.clearValue', field: 'short_description', args: [], result: { before: 'Printer broken', after: '', changed: true }, t: 340, at: 1_700_000_000_340, stack: frameFor(ID_CS2) }),
    ev({ field: 'u_missing', args: ['x'], flags: { unknownField: true }, t: 400, at: 1_700_000_000_400, stack: [{ fn: 'mystery', line: 5, col: 6, url: '/incident.do' }] }),
  ]);
}

test('story: who set the field, what happened next, in plain words', () => {
  const stories = trace.buildStories(storyRows(), RESOLVED);
  assert.equal(stories.length, 2);
  const s = stories.find((x) => x.field === 'short_description');
  assert.equal(
    s.summary,
    'short_description: set to "Printer broken" at 120 ms by Client script: Set defaults (onLoad), then made mandatory at 200 ms by Client script: Set defaults (onLoad), then cleared (it was "Printer broken") at 340 ms by Client script: Reset on category (onChange on category)'
  );
  assert.equal(s.scripts, 2, 'two different scripts changed its value');
  assert.equal(s.steps[0].known, true);
  const missing = stories.find((x) => x.field === 'u_missing');
  assert.match(missing.summary, /the field is not on the form, so ServiceNow ignored it/);
  assert.match(missing.summary, /by an unknown script/);
});

test('the verb for each g_form call', () => {
  const v = (name, args, extra = {}) => trace.verbFor({ name: `g_form.${name}`, args, ...extra });
  assert.equal(v('setValue', ['b'], { result: { before: 'a', after: 'b', changed: true } }), 'changed from "a" to "b"');
  assert.equal(v('setValue', ['b'], { result: { before: '', after: 'b', changed: true } }), 'set to "b"');
  assert.equal(v('setValue', ['b'], { result: { before: 'a', after: 'a', changed: false } }), 'tried to set "b" but the value stayed "a"');
  assert.equal(v('setValue', ['a'], { result: { before: 'a', after: 'a', changed: false } }), 'set to "a" (it already had that value)');
  assert.equal(v('setValue', ['x'], { flags: { hidden: true } }), 'set (value not recorded)');
  assert.equal(v('setReadOnly', [true]), 'made read-only');
  assert.equal(v('setReadOnly', [false]), 'made editable');
  assert.equal(v('setVisible', [false]), 'hidden (setVisible)');
  assert.equal(v('setDisplay', [true]), 'shown (setDisplay)');
  assert.equal(v('setDisabled', [true]), 'disabled');
  assert.equal(v('showFieldMsg', ['Careful', 'error']), 'showed the message "Careful" (error)');
  assert.equal(v('removeOption', ['3']), 'lost the option "3"');
  assert.equal(v('clearOptions', []), 'had all its options removed');
});

test('findings: slow and blocking GlideAjax, repeats, unknown fields, errors, the gap, busy time', () => {
  const calls = [];
  for (let i = 0; i < 4; i += 1) {
    calls.push(ev({ kind: 'ajax', name: 'GlideAjax.getXML', phase: 'start', args: ['IncidentUtils', 'getDefaults', { sysparm_caller: 'abc' }], t: 100 + i * 50, at: 1_700_000_000_100 + i * 50 }));
    calls.push(ev({ kind: 'ajax', name: 'GlideAjax.getXML', phase: 'end', ref: calls[calls.length - 1].id, durationMs: i === 0 ? 1800 : 120, t: 300 + i * 50, at: 1_700_000_000_300 + i * 50 }));
  }
  const events = [
    ev({ kind: 'page', name: 'page load started', args: ['/incident.do', 'loading'], t: 0, at: 1_700_000_000_000 }),
    ...calls,
    ev({ kind: 'ajax', name: 'GlideAjax.getXMLWait', args: ['Slow', 'wait', {}], durationMs: 650, flags: { blocking: true }, t: 900, at: 1_700_000_000_900 }),
    ev({ kind: 'glide', name: 'GlideRecord.query', args: ['incident', 'active=true'], durationMs: 40, flags: { blocking: true }, t: 960, at: 1_700_000_000_960 }),
    ev({ field: 'u_nope', args: ['x'], flags: { unknownField: true }, t: 1000, at: 1_700_000_001_000 }),
    ev({ kind: 'error', name: 'TypeError', args: ['x is undefined'], flags: { exception: true }, t: 1100, at: 1_700_000_001_100 }),
    ev({ kind: 'longtask', name: 'Long task', durationMs: 1400, t: 1200, at: 1_700_000_001_200 }),
    ev({ kind: 'network', name: 'GET /api/now/table/x', durationMs: 20, result: { status: 500 }, flags: { failed: true }, t: 4200, at: 1_700_000_004_200 }),
  ];
  const rows = trace.buildRows(events);
  const findings = trace.findFindings(rows, {});
  const ids = findings.map((f) => f.id.split('-')[0]);
  ['slow', 'blocking', 'repeat', 'unknown', 'error', 'busy', 'failed', 'gap'].forEach((k) => assert.ok(ids.includes(k), `${k} in ${ids.join(',')}`));
  const slow = findings.find((f) => f.id.startsWith('slow-'));
  assert.equal(slow.severity, 'medium');
  assert.match(slow.title, /IncidentUtils\.getDefaults took 1\.80 s/);
  const repeat = findings.find((f) => f.id.startsWith('repeat-'));
  assert.match(repeat.title, /called 4 times: IncidentUtils\.getDefaults/);
  assert.equal(repeat.rowKeys.length, 4);
  const slowWait = findings.find((f) => f.id.startsWith('slow-') && /Slow\.wait/.test(f.title));
  assert.equal(slowWait.severity, 'medium');
  assert.match(slowWait.detail, /synchronous, so the browser was frozen/);
  const blocking = findings.find((f) => f.id.startsWith('blocking-'));
  assert.match(blocking.title, /GlideRecord incident query/);
  assert.equal(blocking.severity, 'low', 'a fast synchronous call is still worth knowing about, but is not urgent');
  const gap = findings.find((f) => f.id === 'gap');
  assert.match(gap.title, /Biggest gap: 1\.\d+ s/);
  // most serious first
  assert.equal(findings[0].severity, 'high');
  assert.ok(findings.map((f) => f.severity).join(' ').indexOf('low') > findings.map((f) => f.severity).join(' ').lastIndexOf('medium'));
});

test('findings: the silent gap is only reported for a recording that began with the page load', () => {
  const quiet = (withStart) =>
    trace.buildRows([
      ...(withStart ? [ev({ kind: 'page', name: 'page load started', args: ['/x.do', 'loading'], t: 0, at: 1_700_000_000_000 })] : [ev({ kind: 'page', name: 'recording started', args: ['/x.do', 'complete'], t: 5000, at: 1_700_000_005_000 })]),
      ev({ field: 'a', args: ['1'], t: 100, at: 1_700_000_000_100 }),
      ev({ field: 'b', args: ['1'], t: 2600, at: 1_700_000_002_600 }),
      ev({ field: 'c', args: ['1'], t: 40000, at: 1_700_000_040_000 }),
    ]);
  assert.ok(trace.findFindings(quiet(true), {}).some((f) => f.id === 'gap'));
  assert.ok(!trace.findFindings(quiet(false), {}).some((f) => f.id === 'gap'), 'a gap in a live recording is the person thinking');
  const late = trace.findFindings(quiet(true), {}).find((f) => f.id === 'gap');
  assert.match(late.title, /2.50 s/, 'the 40 s event is outside the page-load window');
});

test('findings: nothing stands out in a quiet recording', () => {
  const rows = trace.buildRows([ev({ field: 'category', args: ['x'], result: { before: 'a', after: 'x', changed: true }, t: 10, at: 1_700_000_000_010 }), ev({ field: 'priority', args: ['1'], t: 60, at: 1_700_000_000_060 })]);
  assert.deepEqual(trace.findFindings(rows, {}), []);
});

test('findings: a field two scripts fight over; script includes that are missing or not client callable', () => {
  const rows = storyRows();
  const f = trace.findFindings(rows, RESOLVED);
  assert.ok(f.some((x) => x.id.startsWith('contested-') && /short_description was changed by 2 different scripts/.test(x.title)));
  const ajax = trace.buildRows([
    ev({ kind: 'ajax', name: 'GlideAjax.getXML', args: ['NotThere', 'm', {}], t: 1, at: 1 }),
    ev({ kind: 'ajax', name: 'GlideAjax.getXML', args: ['Private', 'm', {}], t: 2, at: 2 }),
    ev({ kind: 'ajax', name: 'GlideAjax.getXML', args: ['Fine', 'm', {}], t: 3, at: 3 }),
  ]);
  const found = trace.findFindings(ajax, { classes: { NotThere: { found: false }, Private: { found: true, clientCallable: false }, Fine: { found: true, clientCallable: true } } });
  assert.ok(found.some((x) => x.id === 'class-missing-NotThere'));
  const callable = found.find((x) => x.id === 'class-callable-Private');
  assert.equal(callable.severity, 'high');
  assert.ok(!found.some((x) => /Fine/.test(x.id)));
});

test('two unknown scripts at different places are different scripts; the same place is one', () => {
  const rows = trace.buildRows([
    ev({ field: 'f', args: ['a'], result: { changed: true }, t: 1, at: 1, stack: [{ fn: 'one', line: 1, col: 1 }] }),
    ev({ field: 'f', args: ['b'], result: { changed: true }, t: 2, at: 2, stack: [{ fn: 'two', line: 9, col: 1 }] }),
    ev({ field: 'g', args: ['a'], result: { changed: true }, t: 1, at: 1, stack: [{ fn: 'same', line: 1, col: 1 }] }),
    ev({ field: 'g', args: ['b'], result: { changed: true }, t: 2, at: 2, stack: [{ fn: 'same', line: 1, col: 1 }] }),
  ]);
  const stories = trace.buildStories(rows, {});
  assert.equal(stories.find((s) => s.field === 'f').scripts, 2);
  assert.equal(stories.find((s) => s.field === 'g').scripts, 1);
});

test('filters: field, kind, errors only, slow only', () => {
  const rows = trace.buildRows([
    ev({ field: 'category', args: ['x'], t: 1, at: 1 }),
    ev({ field: 'priority', args: ['1'], t: 2, at: 2 }),
    ev({ kind: 'ajax', name: 'GlideAjax.getXML', args: ['U', 'm', {}], durationMs: 900, t: 3, at: 3 }),
    ev({ kind: 'error', name: 'Error', args: ['bad'], t: 4, at: 4 }),
    ev({ field: 'nope', args: ['x'], flags: { unknownField: true }, t: 5, at: 5 }),
  ]);
  assert.equal(trace.filterRows(rows, { field: 'category' }).length, 1);
  assert.equal(trace.filterRows(rows, { kind: 'ajax' }).length, 1);
  assert.equal(trace.filterRows(rows, { kind: 'problems' }).length, 1);
  assert.equal(trace.filterRows(rows, { errorsOnly: true }).length, 2, 'an error and a call on a missing field');
  assert.equal(trace.filterRows(rows, { slowOnly: true }).length, 1);
  assert.equal(trace.filterRows(rows, {}).length, 5);
  assert.deepEqual(trace.fieldsOf(rows), ['category', 'nope', 'priority']);
});

test('page loads: by default only the newest load of each frame; the form frame and the shell are kept apart', () => {
  const rows = trace.buildRows([
    ev({ rid: 'a', frame: 'gsft_main', kind: 'page', name: 'page load started', args: ['/incident.do'], at: 1000 }),
    ev({ rid: 'a', frame: 'gsft_main', field: 'old', at: 1100 }),
    ev({ rid: 'b', frame: 'gsft_main', kind: 'page', name: 'page load started', args: ['/problem.do'], at: 5000 }),
    ev({ rid: 'b', frame: 'gsft_main', field: 'new', at: 5100 }),
    ev({ rid: 'c', frame: 'top', kind: 'error', name: 'Error', args: ['shell'], at: 3000 }),
  ]);
  const docs = trace.documentsOf(rows);
  assert.deepEqual(docs.map((d) => d.rid), ['a', 'c', 'b']);
  assert.equal(docs[2].href, '/problem.do');
  assert.deepEqual(trace.selectDocuments(rows, 'current').map((r) => r.field || r.name).sort(), ['Error', 'new', 'page load started'].sort());
  assert.equal(trace.selectDocuments(rows, 'all').length, 5);
});

test('Markdown report: findings, stories, a timeline table with the script, and an honest cap', () => {
  const rows = storyRows();
  const md = trace.toMarkdown({
    rows,
    findings: trace.findFindings(rows, RESOLVED),
    stories: trace.buildStories(rows, RESOLVED),
    resolved: RESOLVED,
    meta: { host: 'dev1.service-now.com', page: '/incident.do', recordedAt: 1_700_000_000_000, scope: 'current' },
  });
  assert.match(md, /^## Client trace/);
  assert.match(md, /Instance: dev1\.service-now\.com/);
  assert.match(md, /### What stands out/);
  assert.match(md, /### Field stories/);
  assert.match(md, /\| Time \| Kind \| What \| Script \| Duration \|/);
  assert.match(md, /Client script: Set defaults \(onLoad\)/);
  assert.match(md, /Unknown script \(mystery at \/incident\.do:5:6\)/);
  assert.ok(!md.includes('\n\n\n'));
  const capped = trace.toMarkdown({ rows, maxRows: 2 });
  assert.match(capped, /Only the first 2 of 5 events are shown\./);
  assert.match(trace.toMarkdown({ rows: [] }), /Nothing was recorded\./);
  const piped = trace.toMarkdown({ rows: trace.buildRows([ev({ kind: 'error', name: 'Error', args: ['a | b\nc'], t: 1, at: 1 })]) });
  assert.match(piped, /a \\\| b c/);
});

test('events that arrive from other frames are rebuilt from known fields; junk is dropped', () => {
  const good = trace.sanitizeEvent({ seq: 4, id: 2, kind: 'ajax', name: 'GlideAjax.getXML', t: 5, at: 6, frame: 'gsft_main', args: ['U', 'm', { a: 'b' }], phase: 'start', flags: { blocking: true, evil: 'yes' }, stack: [{ fn: 'f', line: 1, col: 2, url: '/a.js', extra: 'x' }], __proto__: { polluted: true }, onclick: 'alert(1)' });
  assert.deepEqual(Object.keys(good).sort(), ['args', 'at', 'frame', 'flags', 'id', 'kind', 'name', 'phase', 'seq', 'stack', 't'].sort());
  assert.deepEqual(good.flags, { blocking: true });
  assert.deepEqual(good.stack, [{ fn: 'f', line: 1, col: 2, url: '/a.js' }]);
  assert.equal(trace.sanitizeEvent({ seq: 1, kind: 'bogus', name: 'x' }), null);
  assert.equal(trace.sanitizeEvent({ seq: 'x', kind: 'field', name: 'x' }), null);
  assert.equal(trace.sanitizeEvent(null), null);
  assert.equal(trace.sanitizeEvent('string'), null);
  const big = trace.sanitizeEvent({ seq: 1, kind: 'console', name: 'console.error', args: Array.from({ length: 40 }, () => 'x'.repeat(2000)), stack: Array.from({ length: 50 }, () => ({ fn: 'f' })) });
  assert.equal(big.args.length, 8);
  assert.ok(big.args[0].length <= 300);
  assert.equal(big.stack.length, 8);
});

test('time formatting', () => {
  assert.equal(trace.fmtMs(3.14159), '3.1 ms');
  assert.equal(trace.fmtMs(120.4), '120 ms');
  assert.equal(trace.fmtMs(1800), '1.80 s');
  assert.equal(trace.fmtMs(12345), '12.3 s');
  assert.equal(trace.fmtMs(NaN), '');
});

test('filters: by frame; a request the page cancelled is not a failure', () => {
  const rows = trace.buildRows([
    ev({ rid: 'a', frame: 'top', kind: 'network', name: 'GET /api/now/ui/x', result: { status: 200 }, durationMs: 5, t: 1, at: 1 }),
    ev({ rid: 'b', frame: 'gsft_main', field: 'category', args: ['x'], t: 2, at: 2 }),
    ev({ rid: 'b', frame: 'gsft_main', kind: 'network', name: 'GET /api/now/table/incident', result: { status: 0, aborted: true }, durationMs: 3, t: 3, at: 3 }),
    ev({ rid: 'b', frame: 'gsft_main', kind: 'network', name: 'GET /api/now/table/x', result: { status: 0 }, durationMs: 3, flags: { failed: true }, t: 4, at: 4 }),
  ]);
  assert.deepEqual(trace.framesOf(rows), ['gsft_main', 'top']);
  assert.equal(trace.filterRows(rows, { frame: 'gsft_main' }).length, 3);
  assert.equal(trace.filterRows(rows, { frame: 'top' }).length, 1);
  assert.equal(trace.filterRows(rows, { errorsOnly: true }).length, 1, 'only the request that really failed');
  assert.equal(trace.describeRow(rows[2]).detail, 'cancelled by the page');
  const findings = trace.findFindings(rows, {});
  assert.equal(findings.filter((f) => f.id.startsWith('failed-')).length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// The content-side lookups ("which script was that?") against a fake instance
// ---------------------------------------------------------------------------------------------------------------------

// The content module registers its window listeners once, when it is first loaded (into whichever fake window is current).
const windowListeners = [];

function fakeInstance(db, { failTables = [], missingTables = [] } = {}) {
  const calls = [];
  const docEvents = new EventTarget();
  docEvents.documentElement = { hasAttribute: () => true };
  docEvents.querySelector = () => null;
  docEvents.scripts = [];
  docEvents.addEventListener('msb-page-request', (e) => {
    docEvents.dispatchEvent(new CustomEvent('msb-page-response', { detail: { id: e.detail.id, ok: true, result: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' } }));
  });
  const win = {
    location: { origin: 'https://dev1.service-now.com', hostname: 'dev1.service-now.com', host: 'dev1.service-now.com', pathname: '/' },
    addEventListener(type, fn) {
      windowListeners.push({ type, fn });
    },
    frames: [],
    document: docEvents,
  };
  win.top = win;
  win.parent = win;
  globalThis.window = win;
  globalThis.document = docEvents;
  globalThis.fetch = async (url) => {
    const u = new URL(url, 'https://dev1.service-now.com');
    const table = decodeURIComponent(u.pathname.split('/').pop());
    const query = u.searchParams.get('sysparm_query') || '';
    calls.push({ table, query });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (failTables.includes(table)) return json({ error: { message: 'Insufficient rights' } }, 403);
    if (table === 'sys_db_object') {
      const one = /^name=(\w+)$/.exec(query);
      if (one) return json({ result: [{ name: one[1], 'super_class.name': { incident: 'task', problem: 'task' }[one[1]] || '' }] });
      const wanted = /nameIN(.*)/.exec(query)[1].split(',');
      return json({ result: wanted.filter((n) => !missingTables.includes(n)).map((name) => ({ name })) });
    }
    // field=value, fieldINa,b, fieldLIKEtext joined by ^; a condition on a column the rows lack is ignored (matches every
    // row), like ServiceNow does.
    const conditions = query ? query.split('^') : [];
    const rows = (db[table] || []).filter((row) =>
      conditions.every((c) => {
        let m = /^([a-z_.]+)IN(.*)$/.exec(c);
        if (m) return !(m[1] in row) || m[2].split(',').includes(String(row[m[1]]));
        m = /^([a-z_.]+)LIKE([\s\S]*)$/.exec(c);
        if (m) return !(m[1] in row) || String(row[m[1]]).includes(m[2]);
        m = /^([a-z_.]+)=(.*)$/.exec(c);
        if (m) return !(m[1] in row) || String(row[m[1]]) === m[2];
        return true;
      })
    );
    return json({ result: rows });
  };
  return calls;
}

const loadContent = () => {
  const mod = require('../src/content/clientTrace.js');
  mod.resetLookupCache();
  return mod;
};

test('lookups: a confirmed id gets its name; rows that were not asked for are ignored; catalog rows replace their parent row', async () => {
  const calls = fakeInstance({
    sys_script_client: [
      { sys_id: ID_CS, name: 'Set defaults', table: 'incident', type: 'onLoad', field: '' },
      { sys_id: 'ffffffffffffffffffffffffffffffff', name: 'A row nobody asked for', table: 'x', type: 'onLoad', field: '' },
      { sys_id: ID_CS2, name: 'Parent view of a catalog script', table: '', type: 'onChange', field: '' },
    ],
    catalog_script_client: [{ sys_id: ID_CS2, name: 'Catalog onChange', type: 'onChange', cat_item: 'Laptop' }],
  });
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const out = await clientTraceResolve({ ids: [ID_CS, ID_CS2, ID_CS, 'not-an-id', `${ID_CS}^evil=1`] });
  assert.deepEqual(Object.keys(out.ids).sort(), [ID_CS, ID_CS2].sort());
  assert.equal(out.ids[ID_CS].name, 'Set defaults');
  assert.equal(out.ids[ID_CS].table, 'sys_script_client');
  assert.equal(out.ids[ID_CS2].table, 'catalog_script_client', 'the subclass is more specific');
  assert.equal(out.ids[ID_CS2].name, 'Catalog onChange');
  assert.ok(!out.ids.ffffffffffffffffffffffffffffffff);
  assert.ok(calls.every((c) => !/evil|not-an-id/.test(c.query)), 'only valid ids are ever put in a query');
  // the labels the panel will show
  assert.equal(trace.attribute(ev({ stack: frameFor(ID_CS) }), out).label, 'Client script: Set defaults (onLoad)');
  assert.equal(trace.attribute(ev({ stack: frameFor(ID_CS2) }), out).label, 'Catalog client script: Catalog onChange (onChange)');
  // asked once, remembered: a second call asks the instance nothing about these ids
  const before = calls.length;
  await clientTraceResolve({ ids: [ID_CS, ID_CS2] });
  assert.equal(calls.length, before);
});

test('lookups: a table the instance does not have is skipped, not reported', async () => {
  const calls = fakeInstance({ sys_ui_policy: [{ sys_id: '0123456789abcdef0123456789abcdef', short_description: 'Hide cause', table: 'incident' }] }, { missingTables: ['catalog_script_client', 'catalog_ui_policy'] });
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const out = await clientTraceResolve({ ids: ['0123456789abcdef0123456789abcdef'] });
  assert.equal(out.ids['0123456789abcdef0123456789abcdef'].name, 'Hide cause');
  assert.equal(out.ids['0123456789abcdef0123456789abcdef'].kind, 'UI policy');
  assert.deepEqual(out.notes, []);
  assert.ok(!calls.some((c) => c.table === 'catalog_script_client' || c.table === 'catalog_ui_policy'), 'no query to a table that does not exist');
});

test('lookups: a table that cannot be read leaves a visible note and the id is asked again next time', async () => {
  const calls = fakeInstance({ sys_script_client: [] }, { failTables: ['sys_ui_action'] });
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const out = await clientTraceResolve({ ids: ['89abcdef0123456789abcdef01234567'] });
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /Could not check sys_ui_action/);
  assert.deepEqual(out.ids, {}, 'unknown stays unknown');
  const first = calls.length;
  await clientTraceResolve({ ids: ['89abcdef0123456789abcdef01234567'] });
  assert.ok(calls.length > first, 'not remembered as "not found" because one table could not be read');
});

test('lookups: UI scripts by exact file name, and GlideAjax classes: found, not found, client callable or not', async () => {
  const calls = fakeInstance({
    sys_ui_script: [{ sys_id: 'a'.repeat(32), name: 'my_lib' }, { sys_id: 'b'.repeat(32), name: 'my_lib_other' }],
    sys_script_include: [
      { sys_id: '1'.repeat(32), name: 'IncidentUtils', api_name: 'global.IncidentUtils', client_callable: 'true' },
      { sys_id: '2'.repeat(32), name: 'Private', api_name: 'global.Private', client_callable: 'false' },
      { sys_id: '3'.repeat(32), name: 'Scoped', api_name: 'x_acme.Scoped', client_callable: 'true' },
      { sys_id: '4'.repeat(32), name: 'Scoped', api_name: 'x_other.Scoped', client_callable: 'false' },
    ],
  });
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const out = await clientTraceResolve({ names: ['my_lib', 'missing_lib', 'bad name;'], classes: ['IncidentUtils', 'Private', 'NoSuchClass', 'x_acme.Scoped', 'x_other.Scoped', 'bad;class'] });
  assert.equal(out.names.my_lib.name, 'my_lib');
  assert.ok(!out.names.missing_lib);
  assert.deepEqual(out.classes.IncidentUtils, { found: true, sysId: '1'.repeat(32), clientCallable: true });
  assert.equal(out.classes.Private.clientCallable, false);
  assert.deepEqual(out.classes.NoSuchClass, { found: false });
  assert.equal(out.classes['x_acme.Scoped'].clientCallable, true, 'the scoped class is told apart by its API name');
  assert.equal(out.classes['x_other.Scoped'].clientCallable, false);
  assert.ok(!('bad;class' in out.classes));
  assert.ok(calls.every((c) => !/bad/.test(c.query)));
});

test('lookups: a class lookup that fails says nothing about the class (never "not found")', async () => {
  fakeInstance({}, { failTables: ['sys_script_include'] });
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const out = await clientTraceResolve({ classes: ['WhoKnows'] });
  assert.deepEqual(out.classes, {});
  assert.match(out.notes.join(' '), /Could not check sys_script_include/);
});

test('the preview sample is only honoured off ServiceNow', async () => {
  fakeInstance({});
  globalThis.__msbClientTraceFixture = { state: { armed: false }, events: [{ sample: true }], version: 3 };
  globalThis.window.location.hostname = 'localhost';
  const { clientTraceLoad } = loadContent().clientTraceServices;
  assert.equal((await clientTraceLoad()).version, 3);
  globalThis.window.location.hostname = 'dev1.service-now.com';
  const real = await clientTraceLoad();
  assert.notEqual(real.version, 3, 'a page on ServiceNow cannot feed the panel fake events');
  delete globalThis.__msbClientTraceFixture;
});

test('content: a forged (untrusted) message cannot put events in the panel; a real one from a child frame can; floods stay small', async () => {
  fakeInstance({});
  const mod = loadContent();
  const listener = windowListeners.find((l) => l.type === 'message');
  assert.ok(listener, 'the module listens for frame messages');
  const message = (rid, isTrusted) => ({
    isTrusted,
    origin: 'https://dev1.service-now.com',
    source: null, // what a page script can claim in a constructed MessageEvent
    data: { source: 'msb-trace', type: 'events', final: true, payload: { rid, frame: 'gsft_main', lastSeq: 1, events: [{ seq: 1, id: 1, kind: 'console', name: 'console.error', t: 1, at: 1, frame: 'gsft_main', args: ['made up'], stack: [] }] } },
  });
  listener.fn(message('forged-1', false));
  let load = await mod.clientTraceServices.clientTraceLoad();
  assert.ok(!load.events.some((e) => e.rid === 'forged-1'), 'an untrusted event is ignored');
  listener.fn(message('real-1', true));
  load = await mod.clientTraceServices.clientTraceLoad();
  assert.ok(load.events.some((e) => e.rid === 'real-1'), 'a real postMessage from an unloading child frame is kept');
  for (let i = 0; i < 300; i += 1) listener.fn(message(`flood-${i}`, true));
  const state = await mod.clientTraceServices.clientTraceStatus();
  assert.ok(state.frames.length <= 40, `${state.frames.length} frames remembered`);
});

test('content: a recorder still running in this frame counts as recording even when the page cleared the flag', async () => {
  fakeInstance({});
  const mod = loadContent();
  const pageWin = makeWindow({ top: 'self' });
  pageWin.document = globalThis.document; // the content script and the recorder share the DOM
  const rec = makeRecorder(pageWin, { epoch: () => Date.now() });
  rec.attachTransport();
  rec.start(Date.now() + 10 * 60_000); // armed, but there is no flag in sessionStorage
  const state = await mod.clientTraceServices.clientTraceStatus();
  assert.equal(state.recorder, 'running');
  assert.equal(state.armed, true, 'the panel keeps offering Stop recording');
  assert.ok(state.minutesLeft >= 9 && state.minutesLeft <= 11, String(state.minutesLeft));
  rec.stop();
  assert.equal((await mod.clientTraceServices.clientTraceStatus()).armed, false);
});

test('lookups: when the table check sees none of the tables (rows hidden by ACL), every table is still asked', async () => {
  const calls = fakeInstance({ sys_script_client: [{ sys_id: ID_CS, name: 'Set defaults', table: 'incident', type: 'onLoad', field: '' }] }, { missingTables: trace.RESOLVE_TABLES.map((t) => t.table) });
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const out = await clientTraceResolve({ ids: [ID_CS] });
  assert.equal(out.ids[ID_CS]?.name, 'Set defaults', 'not silently "Unknown script"');
  assert.ok(calls.some((c) => c.table === 'sys_script_client'));
});

test('lookups: at most 200 ids per call however many arrive, and junk input does not throw', async () => {
  const calls = fakeInstance({});
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const ids = Array.from({ length: 1000 }, (_, i) => i.toString(16).padStart(32, '0'));
  await clientTraceResolve({ ids });
  const asked = new Set(calls.filter((c) => c.table === 'sys_script_client').flatMap((c) => /sys_idIN(.*)/.exec(c.query)[1].split(',')));
  assert.equal(asked.size, 200);
  await assert.doesNotReject(() => clientTraceResolve({ ids: 'not a list', names: null, classes: 42 }));
});

test('Markdown report: text from the page cannot become a link, an image or HTML in the ticket', () => {
  const rows = trace.buildRows([ev({ kind: 'console', name: 'console.error', args: ['![x](https://evil.example/t.png) <img src=x onerror=alert(1)> [click](javascript:alert(1))'], t: 1, at: 1 })]);
  const md = trace.toMarkdown({ rows, findings: trace.findFindings(rows, {}) });
  assert.ok(!md.includes('![x]('), md);
  assert.ok(!/(^|[^\\])<img/.test(md), md);
  assert.ok(!md.includes('[click]('), md);
  assert.ok(md.includes(String.raw`\[click\]`), 'shown as the text it was');
  const marked = trace.toMarkdown({ rows: trace.buildRows([ev({ kind: 'console', name: 'console.error', args: ['password=[hidden] and [hidden](https://x.example)'], t: 1, at: 1 })]) });
  assert.ok(marked.includes('password=[hidden] and '), 'the recorder marker stays readable');
  assert.ok(!marked.includes('[hidden](https'), 'but not when it would make a link');
});

// ---------------------------------------------------------------------------------------------------------------------
// Attribution from the page's own source (shapes confirmed live on a PDI, 2026-10-23): inline onLoad_<hex> functions,
// ui_policy_add([...]) data, UI policy engine frames in /scripts/ui_policy.jsx, platform jslog noise.
// ---------------------------------------------------------------------------------------------------------------------

const ONLOAD = 'onLoad_9b1e0e5d0f2a4c7e8a1b2c3d4e5f6a7b';
const POL_CLOSE = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const POL_HR = '1a1b2c3d4e5f60718293a4b5c6d7e8f9';
const POL_IT = '2a1b2c3d4e5f60718293a4b5c6d7e8f9';
const PAGE_SCRIPT = [
  'function ui_policy_add(list) { for (var i = 0; i < list.length; i++) g_policies.push(list[i]); }',
  `ui_policy_add([{"actions":[{"cleared":"false","disabled":"ignore","mandatory":"true","name":"close_notes","visible":"ignore"}],"condition_fields":"state","conditions":"state=6^EQ","onload":"true","reverse":"true","script_false":"","script_true":"function onCondition() { var x = '}]'; }","short_description":"Close notes required when resolved","source_table":"incident","sys_id":"${POL_CLOSE}","table":"incident"},`,
  `{"actions":[{"cleared":"false","disabled":"ignore","mandatory":"ignore","name":"u_bsm","visible":"false"}],"short_description":"Hide BSM for HR","sys_id":"${POL_HR}","table":"incident"},`,
  `{"actions":[{"cleared":"false","disabled":"ignore","mandatory":"ignore","name":"u_bsm","visible":"true"}],"short_description":"Show BSM for IT [x]","sys_id":"${POL_IT}","table":"incident"}]);`,
  'catalog_ui_policy_add([{"actions":[{"name":"close_notes","mandatory":"true"}],"short_description":"Another format","sys_id":"ffffffffffffffffffffffffffffffff"}]);',
  `function ${ONLOAD}() {`,
  '  // set the defaults { not code }',
  '  if (g_form.isNewRecord()) {',
  "    g_form.setValue('short_description', 'Printer broken on floor three');",
  "    g_form.setMandatory('close_notes', true);",
  '    var msg = "a } inside a string";',
  '  }',
  '}',
  `window.onCondition_${POL_CLOSE}_true = function () { g_form.setMandatory('close_notes', true); };`,
].join('\n');
const CLIENT_SCRIPT_SOURCE = "function onLoad() {\n\t// set the defaults { not code }\n\tif (g_form.isNewRecord()) {\n\t\tg_form.setValue('short_description', 'Printer broken on floor three');\n\t\tg_form.setMandatory('close_notes', true);\n\t\tvar msg = \"a } inside a string\";\n\t}\n}";

test('page source: UI policies from ui_policy_add JSON (brackets inside strings, the definition and other formats skipped)', () => {
  const { policies, failed } = trace.extractUiPolicies([PAGE_SCRIPT, 'ui_policy_add([{"actions": [ broken json ]);']);
  assert.equal(failed, 1, 'the unreadable call is counted, so the panel can say so');
  assert.deepEqual(policies.map((p) => p.sysId), [POL_CLOSE, POL_HR, POL_IT]);
  assert.equal(policies[0].name, 'Close notes required when resolved');
  assert.deepEqual(policies[0].actions, [{ field: 'close_notes', mandatory: 'true', visible: 'ignore', disabled: 'ignore', cleared: 'false' }]);
  assert.deepEqual(trace.extractUiPolicies([]), { policies: [], failed: 0 });
  assert.deepEqual(trace.extractUiPolicies(['ui_policy_add([{"sys_id":"not-an-id","actions":[{"name":"x","mandatory":"true"}]}]);']).policies[0].sysId, '');
});

test('page source: a function body is cut out exactly (braces in strings and comments), once, or not at all', () => {
  const body = trace.extractFunctionSource([PAGE_SCRIPT], ONLOAD);
  assert.ok(body.includes("g_form.setMandatory('close_notes', true);"));
  assert.ok(body.includes('"a } inside a string"'), 'the brace inside the string did not end the function');
  assert.ok(!body.includes('onCondition_'), 'stops at its own closing brace');
  assert.ok(trace.extractFunctionSource([PAGE_SCRIPT], `onCondition_${POL_CLOSE}_true`).includes('close_notes'), 'name = function () form');
  assert.equal(trace.extractFunctionSource([PAGE_SCRIPT], 'onLoad_missing'), null);
  assert.equal(trace.extractFunctionSource([`function dup() { a(); }\nfunction dup() { b(); }`], 'dup'), null, 'defined twice: which one ran is unknown');
  assert.equal(trace.extractFunctionSource([PAGE_SCRIPT], 'x) || evil('), null);
  assert.equal(trace.extractFunctionSource(['function open() { if (a) { '], 'open'), null, 'unbalanced');
});

test('page source: fragments to search by are distinctive single lines, safe for an encoded query, never secrets', () => {
  const frags = trace.sourceFragments(trace.extractFunctionSource([PAGE_SCRIPT], ONLOAD));
  assert.deepEqual(frags, ["g_form.setValue('short_description', 'Printer broken on floor three');", "g_form.setMandatory('close_notes', true);"]);
  const tricky = ["if (isLoading || newValue === '') {", '    return;', "    var x = g_form.getValue('u_cost_center') ^ mask;", "    var password = 'S3cretS3cretS3cret';", '    // a comment line that is long enough to count'].join('\n');
  const out = trace.sourceFragments(tricky, 5);
  assert.ok(out.every((f) => f.length >= 25 && !/[\^=<>!\n]/.test(f)), JSON.stringify(out));
  assert.ok(out.some((f) => f.startsWith("g_form.getValue('u_cost_center')")), JSON.stringify(out));
  assert.ok(!out.some((f) => /isLoading|S3cret|comment/.test(f)), JSON.stringify(out));
  assert.deepEqual(trace.sourceFragments(''), []);
});

test('page source: a record is taken for the function only when it holds most of the body, whatever the indentation', () => {
  const body = trace.extractFunctionSource([PAGE_SCRIPT], ONLOAD);
  assert.equal(trace.sourceMatches(body, CLIENT_SCRIPT_SOURCE), true);
  assert.equal(trace.sourceMatches(body, "function onLoad() {\n g_form.setValue('short_description', 'Printer broken on floor three');\n alert('other');\n}"), false, 'one shared line is not enough');
  assert.equal(trace.sourceMatches(body, ''), false);
});

test('stack frames: the page function a frame is in, as the page defines it', () => {
  assert.equal(trace.pageFunctionName({ fn: 'Object.onChange_cmdb_ci_bsm [as cmdb_ci]', url: '/incident.do' }), 'onChange_cmdb_ci_bsm');
  assert.equal(trace.pageFunctionName({ fn: ONLOAD, url: '/incident.do' }), ONLOAD);
  assert.equal(trace.pageFunctionName({ fn: 'klass._runAction', url: '/scripts/ui_policy.jsx' }), '', 'a script file, not the page');
  assert.equal(trace.pageFunctionName({ fn: '', url: '/incident.do' }), '');
  assert.equal(trace.pageFunctionName({ fn: 'f', url: '/incident.do' }), '', 'too short to be worth a lookup');
});

const enginePolicies = () => trace.extractUiPolicies([PAGE_SCRIPT]).policies;
const ENGINE_STACK = [
  { fn: 'klass._runAction', line: 683, col: 11, url: '/scripts/ui_policy.jsx' },
  { fn: 'klass._processActions', line: 669, col: 9, url: '/scripts/ui_policy.jsx' },
];

test('UI policy engine: one matching policy is named, several are "one of", none or unreadable say so', () => {
  const resolved = { policies: { r1: enginePolicies() } };
  const one = trace.attribute(ev({ name: 'g_form.setMandatory', field: 'close_notes', args: [true], stack: ENGINE_STACK }), resolved);
  assert.equal(one.label, 'UI policy "Close notes required when resolved"');
  assert.equal(one.known, true);
  assert.deepEqual(one.record, { table: 'sys_ui_policy', kind: 'UI policy', name: 'Close notes required when resolved', sysId: POL_CLOSE });
  assert.match(one.detail, /only UI policy on this page with a mandatory action on close_notes/);
  // the reverse (made not mandatory when the condition turns false) is the same policy
  assert.equal(trace.attribute(ev({ name: 'g_form.setMandatory', field: 'close_notes', args: [false], stack: ENGINE_STACK }), resolved).label, one.label);
  const several = trace.attribute(ev({ name: 'g_form.setDisplay', field: 'u_bsm', args: [false], stack: ENGINE_STACK }), resolved);
  assert.equal(several.label, 'UI policy engine: one of "Hide BSM for HR", "Show BSM for IT [x]"');
  assert.equal(several.guess, true);
  assert.equal(several.record, null, 'nothing to open: it is not known which one');
  const none = trace.attribute(ev({ name: 'g_form.setReadOnly', field: 'close_notes', args: [true], stack: ENGINE_STACK }), resolved);
  assert.equal(none.label, 'UI policy engine');
  assert.match(none.detail, /No UI policy embedded in this page has a read-only action on close_notes/);
  const unread = trace.attribute(ev({ rid: 'other', name: 'g_form.setMandatory', field: 'close_notes', args: [true], stack: ENGINE_STACK }), resolved);
  assert.equal(unread.label, 'UI policy engine');
  assert.match(unread.detail, /could not be read/);
  // a UI policy's own script: onCondition_<sys_id>_true, the sys_id confirmed by the page's own policy data
  const script = trace.attribute(ev({ name: 'g_form.setMandatory', field: 'close_notes', args: [true], stack: [{ fn: `window.onCondition_${POL_CLOSE}_true`, line: 1, col: 1, url: '/incident.do' }] }), resolved);
  assert.equal(script.label, 'UI policy "Close notes required when resolved" (its script if true)');
});

test('a page function matched by its source text is named, with how it was found; otherwise Unknown script as before', () => {
  const rec = { table: 'sys_script_client', kind: 'Client script', name: 'Set incident defaults', sysId: ID_CS, how: 'source' };
  const row = ev({ name: 'g_form.setMandatory', field: 'close_notes', args: [true], stack: [{ fn: ONLOAD, line: 2253, col: 9, url: '/incident.do' }] });
  const who = trace.attribute(row, { sources: { r1: { [ONLOAD]: rec } } });
  assert.equal(who.label, 'Client script "Set incident defaults" (matched by its source text)');
  assert.equal(who.record.sysId, ID_CS);
  assert.equal(trace.attribute(row, { sources: { r2: { [ONLOAD]: rec } } }).label, 'Unknown script', 'another page load is another page');
  assert.equal(trace.attribute(row, {}).label, 'Unknown script');
  // the refs the panel asks for: page functions with their page, page loads whose UI policies to read
  const refs = trace.collectRefs(trace.buildRows([ev({ kind: 'page', name: 'page load started', args: ['/incident.do', 'loading'] }), row, ev({ name: 'g_form.setMandatory', field: 'close_notes', args: [true], stack: ENGINE_STACK })]));
  assert.deepEqual(refs.functions, [{ rid: 'r1', frame: 'gsft_main', href: '/incident.do', fn: ONLOAD }]);
  assert.deepEqual(refs.pages, [{ rid: 'r1', frame: 'gsft_main', href: '/incident.do' }]);
});

test('platform jslog lines can be hidden; the Markdown says how many were left out', () => {
  const rows = trace.buildRows([ev({ field: 'category', args: ['x'], t: 1, at: 1 }), ...Array.from({ length: 5 }, (_, i) => ev({ kind: 'log', name: 'jslog', args: [`added render event for incident.f${i}`], t: 2 + i, at: 2 + i }))]);
  assert.equal(trace.filterRows(rows, {}).length, 6);
  const shown = trace.filterRows(rows, { hideJslog: true });
  assert.equal(shown.length, 1);
  const md = trace.toMarkdown({ rows: shown, meta: { hiddenLogs: 5 } });
  assert.match(md, /5 platform debug log \(jslog\) lines are not included/);
  assert.match(trace.toMarkdown({ rows: [], meta: { hiddenLogs: 5 } }), /Nothing to show: 5 platform debug log/);
});

/** A form frame (gsft_main) in the fake top window, showing `path` with `script` inlined. */
function withFormFrame(path = '/incident.do', script = PAGE_SCRIPT) {
  const child = { name: 'gsft_main', frames: [], document: { scripts: [{ text: script, src: '' }, { text: '', src: '/scripts/js_includes.jsx' }], location: { pathname: path } } };
  globalThis.window.frames = [child];
  return child;
}

const SCRIPT_ROW = (over) => ({ sys_id: ID_CS, name: 'Set incident defaults', table: 'incident', type: 'onLoad', field: '', active: 'true', script: CLIENT_SCRIPT_SOURCE, ...over });

test('lookups by source text: exactly one active script on the table chain that holds the body is named', async () => {
  const calls = fakeInstance({ sys_script_client: [SCRIPT_ROW(), SCRIPT_ROW({ sys_id: ID_CS2, name: 'Inactive copy', active: 'false' }), SCRIPT_ROW({ sys_id: 'c'.repeat(32), name: 'On another table', table: 'change_request' })] });
  withFormFrame();
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const out = await clientTraceResolve({ functions: [{ rid: 'r9', frame: 'gsft_main', href: '/incident.do', fn: ONLOAD }], pages: [{ rid: 'r9', frame: 'gsft_main', href: '/incident.do' }] });
  assert.equal(out.sources.r9?.[ONLOAD]?.name, 'Set incident defaults', JSON.stringify(out));
  assert.equal(out.sources.r9[ONLOAD].sysId, ID_CS);
  assert.deepEqual(out.policies.r9.map((p) => p.sysId), [POL_CLOSE, POL_HR, POL_IT]);
  const like = calls.filter((c) => /scriptLIKE/.test(c.query));
  assert.ok(like.length >= 1);
  like.forEach((c) => {
    assert.match(c.query, /^active=true(\^tableINincident,task)?\^scriptLIKE/, c.query);
    assert.ok(!/[\^=<>!\n]/.test(c.query.split('scriptLIKE')[1]), `nothing in the fragment can be read as a condition: ${c.query}`);
  });
  assert.ok(like.some((c) => c.table === 'sys_script_client' && c.query.includes('tableINincident,task')), 'the form table and its parent');
  // the panel's label for a call this function made, and for the UI policy engine on that page
  const row = { ...ev({ rid: 'r9', name: 'g_form.setMandatory', field: 'close_notes', args: [true], stack: [{ fn: ONLOAD, line: 2253, col: 9, url: '/incident.do' }] }) };
  assert.equal(trace.attribute(row, out).label, 'Client script "Set incident defaults" (matched by its source text)');
  assert.equal(trace.attribute({ ...row, stack: ENGINE_STACK }, out).label, 'UI policy "Close notes required when resolved"');
});

test('lookups by source text: two active scripts holding the same body, or a page that changed, name nothing', async () => {
  fakeInstance({ sys_script_client: [SCRIPT_ROW(), SCRIPT_ROW({ sys_id: ID_CS2, name: 'Copy on task', table: 'task' })] });
  withFormFrame();
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const out = await clientTraceResolve({ functions: [{ rid: 'r9', frame: 'gsft_main', href: '/incident.do', fn: ONLOAD }], pages: [] });
  assert.deepEqual(out.sources, {}, 'ambiguous: Unknown script, not a pick');
  // the form frame now shows another page than the one recorded: nothing is read from it, and it is asked again later
  fakeInstance({ sys_script_client: [SCRIPT_ROW()] });
  withFormFrame('/problem.do');
  const mod = loadContent();
  const moved = await mod.clientTraceServices.clientTraceResolve({ functions: [{ rid: 'r8', frame: 'gsft_main', href: '/incident.do', fn: ONLOAD }], pages: [{ rid: 'r8', frame: 'gsft_main', href: '/incident.do' }] });
  assert.deepEqual(moved.sources, {});
  assert.equal(moved.policies.r8, undefined);
  assert.deepEqual(moved.pending, { functions: [`r8|${ONLOAD}`], pages: ['r8'] });
});

test('lookups by source text: at most 25 queries per call; the rest are left pending, not "not found"', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `function onChange_f${i}() {\n  g_form.setValue('u_field_${i}', 'value number ${i} for this test');\n}`).join('\n');
  const calls = fakeInstance({ sys_script_client: [] });
  withFormFrame('/incident.do', many);
  const { clientTraceResolve } = loadContent().clientTraceServices;
  const functions = Array.from({ length: 40 }, (_, i) => ({ rid: 'r7', frame: 'gsft_main', href: '/incident.do', fn: `onChange_f${i}` }));
  const out = await clientTraceResolve({ functions, pages: [] });
  assert.ok(calls.filter((c) => /scriptLIKE/.test(c.query)).length <= 25);
  assert.ok(out.pending.functions.length > 0, 'what the budget did not cover is asked again later');
  assert.deepEqual(out.sources, {});
});

test('lookups: the AI tool asks with ids only; page functions and UI policies are then worked out from the recording', async () => {
  fakeInstance({ sys_script_client: [SCRIPT_ROW()] });
  withFormFrame();
  const mod = loadContent();
  const listener = windowListeners.find((l) => l.type === 'message');
  const events = [
    { seq: 1, id: 1, kind: 'page', name: 'page load started', t: 1, at: 1, frame: 'gsft_main', args: ['/incident.do', 'loading'], stack: [] },
    { seq: 2, id: 2, kind: 'field', name: 'g_form.setMandatory', field: 'close_notes', args: [true], t: 2, at: 2, frame: 'gsft_main', stack: ENGINE_STACK },
    { seq: 3, id: 3, kind: 'field', name: 'g_form.setValue', field: 'short_description', args: ['x'], t: 3, at: 3, frame: 'gsft_main', stack: [{ fn: ONLOAD, line: 2253, col: 9, url: '/incident.do' }] },
  ];
  listener.fn({ isTrusted: true, origin: 'https://dev1.service-now.com', source: null, data: { source: 'msb-trace', type: 'events', final: true, payload: { rid: 'agent-1', frame: 'gsft_main', lastSeq: 3, events } } });
  const out = await mod.clientTraceServices.clientTraceResolve({ ids: [], names: [], classes: [] });
  assert.ok(Array.isArray(out.policies['agent-1']), JSON.stringify(Object.keys(out.policies)));
  assert.equal(out.sources['agent-1']?.[ONLOAD]?.name, 'Set incident defaults');
});
