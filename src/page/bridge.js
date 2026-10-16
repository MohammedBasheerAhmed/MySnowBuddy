// PAGE-WORLD script. This file is injected into the ServiceNow page's own
// JavaScript context (not the content script's isolated world) so it can read
// page globals such as `g_form`, `g_user` and `window.g_ck`.
//
// It is loaded via a <script src=chrome-extension://.../pagebridge.js> tag,
// NOT via inline textContent, because ServiceNow serves a Content Security
// Policy on many pages that blocks inline script execution.
//
// Communication contract (both directions use CustomEvent on `document`):
//   content -> page : 'msb-page-request'  detail { id, action, args }
//   page -> content : 'msb-page-response' detail { id, ok, result, error }
//
// SECURITY: this bridge exposes exactly two writes. `setFieldValue` only calls
// g_form.setValue on a field that exists on the form. `saveForm` only calls
// g_form.save(), the same as pressing the form's Save button, and the extension
// asks the user first (with an extra confirmation on production). Both are what
// the page's own client scripts can do. Do not add an "eval" style
// action or anything that executes caller-supplied code - that would let any
// script on the page run arbitrary code through the extension.

(function () {
  if (window.__msbBridgeInstalled) return;
  window.__msbBridgeInstalled = true;

  var REQUEST_EVENT = 'msb-page-request';
  var RESPONSE_EVENT = 'msb-page-response';

  // ServiceNow forms can live in the top window (Next Experience / Polaris)
  // or inside the classic `gsft_main` iframe. Resolve whichever has g_form.
  function resolveFormWindow() {
    if (typeof window.g_form !== 'undefined' && window.g_form) return window;
    try {
      var frame = window.frames['gsft_main'];
      if (frame && typeof frame.g_form !== 'undefined' && frame.g_form) return frame;
    } catch (e) {
      // Cross-origin frame; ignore.
    }
    // The Next Experience shell keeps the classic frame inside shadow DOM, where the named lookup can miss it:
    // try the direct child frames (read-only probe, first match wins).
    try {
      for (var i = 0; i < window.frames.length && i < 20; i++) {
        try {
          var child = window.frames[i];
          if (child && child.g_form && typeof child.g_form.getValue === 'function') return child;
        } catch (e) {
          /* cross-origin child */
        }
      }
    } catch (e) {
      /* no frames */
    }
    return null;
  }

  var MAX_FIELD_CHARS = 500000;
  var SCRIPT_FIELD_RE = /script|condition|advanced|html|css|template|link|filter/i;

  function formFor(win) {
    return win && win.g_form ? win.g_form : null;
  }

  // Names of every field on the form. g_form.getFieldNames() is not present on current releases (verified on
  // Australia), and the whole bridge used to give up without it, so nothing could read or set a form field.
  // g_form.elements is an array of { fieldName, tableName, ... } on those releases.
  function fieldNames(f) {
    var out = [];
    var seen = {};
    function add(name) {
      if (typeof name !== 'string' || !name || seen[name]) return;
      seen[name] = true;
      out.push(name);
    }
    try {
      if (typeof f.getFieldNames === 'function') (f.getFieldNames() || []).forEach(add);
    } catch (e) {
      /* fall through to the other sources */
    }
    if (out.length) return out;
    try {
      var els = f.elements;
      if (els && els.length) for (var i = 0; i < els.length; i++) add(els[i] && els[i].fieldName);
    } catch (e) {
      /* not available */
    }
    if (out.length) return out;
    try {
      if (typeof f.getEditableFields === 'function') (f.getEditableFields() || []).forEach(add);
    } catch (e) {
      /* not available */
    }
    return out;
  }

  // g_user.roles is an array on current releases and a comma-separated string on some older ones.
  function rolesOf(u) {
    try {
      if (Array.isArray(u.roles)) return u.roles.slice(0, 200).map(String);
      if (typeof u.roles === 'string' && u.roles) return u.roles.split(',').map(function (r) { return r.trim(); }).filter(Boolean).slice(0, 200);
    } catch (e) {
      /* not available */
    }
    return null;
  }

  // The list frame exposes g_list (GlideList2) for the list currently shown.
  function resolveListWindow() {
    if (typeof window.g_list !== 'undefined' && window.g_list) return window;
    try {
      var frame = window.frames['gsft_main'];
      if (frame && typeof frame.g_list !== 'undefined' && frame.g_list) return frame;
    } catch (e) {
      // Cross-origin frame; ignore.
    }
    return null;
  }

  var actions = {
    // Returns the CSRF/user token used by ServiceNow for state-changing
    // requests. Content scripts cannot read this directly.
    getCsrfToken: function () {
      if (typeof window.g_ck === 'string' && window.g_ck) return window.g_ck;
      var frameWin = resolveFormWindow();
      if (frameWin && typeof frameWin.g_ck === 'string') return frameWin.g_ck;
      return null;
    },

    // Basic identity/session info, used to label reports and to show who a
    // background script would run as.
    getUserInfo: function () {
      var win = resolveFormWindow() || window;
      if (typeof win.g_user === 'undefined' || !win.g_user) return null;
      return {
        userName: win.g_user.userName || null,
        firstName: win.g_user.firstName || null,
        lastName: win.g_user.lastName || null,
        userId: win.g_user.userID || null,
        roles: rolesOf(win.g_user),
      };
    },

    // Form metadata: which table/record the form is bound to.
    getFormMeta: function () {
      var win = resolveFormWindow();
      if (!win) return null;
      var f = win.g_form;
      return {
        table: typeof f.getTableName === 'function' ? f.getTableName() : null,
        sysId: typeof f.getUniqueValue === 'function' ? f.getUniqueValue() : null,
        isNewRecord: typeof f.isNewRecord === 'function' ? f.isNewRecord() : null,
      };
    },

    // Current (possibly unsaved) values of every field on the form.
    // Used by the pre-save diff to show what is about to be written.
    getFormValues: function () {
      var win = resolveFormWindow();
      if (!win) return null;
      var f = win.g_form;
      var names = fieldNames(f);
      if (!names.length) return null;
      var values = {};
      var labels = {};
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        try {
          var value = f.getValue(name);
          if (value === undefined || value === null) continue;
          values[name] = String(value);
          if (typeof f.getLabelOf === 'function') {
            try {
              labels[name] = f.getLabelOf(name);
            } catch (e) {
              /* some fields have no label element */
            }
          }
        } catch (e) {
          // Field exists in the list but is not readable; skip it.
        }
      }

      return {
        table: typeof f.getTableName === 'function' ? f.getTableName() : null,
        sysId: typeof f.getUniqueValue === 'function' ? f.getUniqueValue() : null,
        isNewRecord: typeof f.isNewRecord === 'function' ? f.isNewRecord() : null,
        values: values,
        labels: labels,
      };
    },

    // Every field on the form with its label, type, state and value, for the AI agent.
    // Read-only. Values are capped so one large field cannot flood the model.
    getFormModel: function () {
      var win = resolveFormWindow();
      var f = formFor(win);
      if (!f) return null;
      var names = fieldNames(f);
      if (!names.length) return null;
      var fields = [];
      for (var i = 0; i < names.length && i < 400; i++) {
        var name = names[i];
        var row = { name: name };
        try { row.label = f.getLabelOf(name); } catch (e) { /* no label element */ }
        try {
          var v = f.getValue(name);
          row.value = v === undefined || v === null ? '' : String(v).slice(0, 300);
        } catch (e) { /* unreadable */ }
        try { if (f.getDisplayBox) { var box = f.getDisplayBox(name); if (box && box.value) row.display = String(box.value).slice(0, 120); } } catch (e) { /* not a reference */ }
        try { row.mandatory = !!f.isMandatory(name); } catch (e) { /* skip */ }
        try { if (f.isReadOnly) row.readOnly = !!f.isReadOnly(name); } catch (e) { /* skip */ }
        try { if (f.isVisible) row.visible = !!f.isVisible(name); } catch (e) { /* skip */ }
        try { var ge = f.getGlideUIElement && f.getGlideUIElement(name); if (ge && ge.type) row.type = String(ge.type); } catch (e) { /* no element info */ }
        fields.push(row);
      }
      var user = null;
      try {
        var gu = win.g_user || window.g_user;
        if (gu) user = { userName: gu.userName, roles: typeof gu.roles === 'string' ? gu.roles : undefined };
      } catch (e) { /* no g_user */ }
      return {
        table: typeof f.getTableName === 'function' ? f.getTableName() : null,
        sysId: typeof f.getUniqueValue === 'function' ? f.getUniqueValue() : null,
        isNewRecord: typeof f.isNewRecord === 'function' ? f.isNewRecord() : null,
        fieldCount: names.length,
        fields: fields,
        user: user,
      };
    },

    // Read-only: whether the open form has unsaved changes, and its section names. Used by navigate (never leave
    // unsaved work) and read_page. Page scripts can already see all of this on g_form.
    getFormStatus: function () {
      var f = formFor(resolveFormWindow());
      if (!f) return null;
      var dirty = null;
      var changed = [];
      try {
        if (typeof f.isDirty === 'function') dirty = !!f.isDirty();
      } catch (e) { /* not on this release */ }
      try {
        if (f.modifiedFields && typeof f.modifiedFields === 'object') {
          for (var key in f.modifiedFields) {
            if (Object.prototype.hasOwnProperty.call(f.modifiedFields, key) && f.modifiedFields[key]) changed.push(String(key).replace(/^[^.]*\./, ''));
          }
        }
      } catch (e) { /* not available */ }
      if (dirty === null && typeof f.modified === 'boolean') dirty = f.modified;
      if (changed.length) dirty = true;
      var sections = null;
      try {
        if (typeof f.getSectionNames === 'function') sections = (f.getSectionNames() || []).slice(0, 40).map(String);
      } catch (e) { /* not available */ }
      return {
        table: typeof f.getTableName === 'function' ? f.getTableName() : null,
        sysId: typeof f.getUniqueValue === 'function' ? f.getUniqueValue() : null,
        isNewRecord: typeof f.isNewRecord === 'function' ? f.isNewRecord() : null,
        dirty: dirty,
        changedFields: changed.slice(0, 40),
        sections: sections,
      };
    },

    // Read-only: who the session is (g_user), for get_instance_info. hasRoleExactly reflects the roles active in
    // this session, so an elevated security_admin shows up only while it is elevated.
    getSessionInfo: function () {
      var win = resolveFormWindow() || window;
      var u = win.g_user || window.g_user;
      if (!u) return null;
      var roles = rolesOf(u);
      function exactly(role) {
        try {
          return typeof u.hasRoleExactly === 'function' ? !!u.hasRoleExactly(role) : null;
        } catch (e) {
          return null;
        }
      }
      return {
        userName: u.userName || null,
        userId: u.userID || null,
        firstName: u.firstName || null,
        lastName: u.lastName || null,
        roles: roles,
        admin: exactly('admin'),
        securityAdmin: exactly('security_admin'),
      };
    },

    // Script-like fields on the form (long text or script-ish names), so the
    // Apply button can offer them as targets.
    getScriptFields: function () {
      var win = resolveFormWindow();
      var f = formFor(win);
      if (!f) return [];
      var out = [];
      var names = fieldNames(f);
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        try {
          var value = f.getValue(name);
          var text = value === undefined || value === null ? '' : String(value);
          if (SCRIPT_FIELD_RE.test(name) || text.indexOf('\n') !== -1 || text.length > 200) {
            var label = name;
            try {
              label = f.getLabelOf(name) || name;
            } catch (e) {
              /* no label element */
            }
            out.push({ name: name, label: label, length: text.length });
          }
        } catch (e) {
          // Unreadable field; skip it.
        }
      }
      return out;
    },

    // Live state of one field, for the field inspector.
    getFieldState: function (name) {
      var f = formFor(resolveFormWindow());
      if (!f) return null;
      var state = { name: String(name) };
      function attempt(key, fn) {
        try {
          state[key] = fn();
        } catch (e) {
          state[key] = null;
        }
      }
      attempt('value', function () {
        return f.getValue(name);
      });
      attempt('displayValue', function () {
        return typeof f.getDisplayValue === 'function' ? f.getDisplayValue(name) : null;
      });
      attempt('label', function () {
        return f.getLabelOf(name);
      });
      attempt('mandatory', function () {
        return f.isMandatory(name);
      });
      attempt('readOnly', function () {
        return f.isReadOnly ? f.isReadOnly(name) : null;
      });
      attempt('visible', function () {
        return f.isVisible ? f.isVisible(name) : null;
      });
      // The field type lets the extension hide password-typed values whatever the field is called.
      attempt('type', function () {
        var ge = f.getGlideUIElement && f.getGlideUIElement(name);
        return ge && ge.type ? String(ge.type) : null;
      });
      return state;
    },

    // The only write on this bridge: set one existing form field. Nothing is
    // saved; the user still has to submit the form.
    setFieldValue: function (name, value) {
      var f = formFor(resolveFormWindow());
      if (!f) throw new Error('No form is open on this page.');
      if (typeof name !== 'string' || typeof value !== 'string') throw new Error('Field name and value must be strings.');
      if (value.length > MAX_FIELD_CHARS) throw new Error('Value is too large.');
      var names = fieldNames(f);
      if (names.indexOf(name) === -1) throw new Error('Field "' + name + '" is not on this form.');
      if (typeof f.isReadOnly === 'function' && f.isReadOnly(name)) throw new Error('Field "' + name + '" is read-only.');
      var previous = f.getValue(name);
      f.setValue(name, value);
      return { previous: previous === undefined || previous === null ? '' : String(previous) };
    },

    // Same as clicking Save on the form.
    saveForm: function () {
      var f = formFor(resolveFormWindow());
      if (!f) throw new Error('No form is open on this page.');
      if (typeof f.save !== 'function') throw new Error('This form cannot be saved from here.');
      f.save();
      return true;
    },

    // Table and active filter of the list on screen.
    getListInfo: function () {
      var win = resolveListWindow();
      if (!win) return null;
      var list = win.g_list;
      var info = { table: null, query: null };
      try {
        if (typeof list.getTableName === 'function') info.table = list.getTableName();
      } catch (e) {
        /* not available on this release */
      }
      try {
        if (typeof list.getQuery === 'function') info.query = list.getQuery();
      } catch (e) {
        /* not available on this release */
      }
      return info;
    },
  };

  document.addEventListener(REQUEST_EVENT, function (event) {
    var detail = (event && event.detail) || {};
    var id = detail.id;
    var action = detail.action;

    function respond(payload) {
      payload.id = id;
      document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, { detail: payload }));
    }

    if (!Object.prototype.hasOwnProperty.call(actions, action)) {
      respond({ ok: false, error: 'Unknown bridge action: ' + action });
      return;
    }

    try {
      respond({ ok: true, result: actions[action].apply(null, detail.args || []) });
    } catch (err) {
      respond({ ok: false, error: (err && err.message) || String(err) });
    }
  });

  document.dispatchEvent(new CustomEvent('msb-page-ready'));
})();
