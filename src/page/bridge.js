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
// SECURITY: this bridge is read-only by design. It exposes no action that
// writes to the record, submits the form, or executes caller-supplied code.
// Do not add an "eval" style action here — that would let any script on the
// page run arbitrary code through the extension.

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
        roles: win.g_user.hasRoleExactly ? undefined : win.g_user.roles || null,
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
      if (typeof f.getFieldNames !== 'function') return null;

      var names = f.getFieldNames() || [];
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
