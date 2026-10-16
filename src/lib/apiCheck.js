// Static check of a script against the verified API catalog.
//
// It catches the failures AI-generated ServiceNow code is most prone to:
//   - calling a method that does not exist (hallucinated or misspelled)
//   - using a client-only API on the server, or a server-only API in the browser
//   - deprecated and scope-restricted APIs
//
// Like lint.js this is regex + light type tracking, not a parser. It only
// reasons about `receiver.method(` where the receiver is a catalog global,
// a catalog class, or a variable created with `new Class(`. Anything it cannot
// resolve it leaves alone, so a clean result means "nothing known is wrong".
import { maskNonCode } from './lint.js';
import { buildScopes } from './scopes.js';
import {
  getApi,
  sidesOf,
  findMethod,
  isComplete,
  allMethodNames,
  closest,
  editDistance,
  GLOBAL_TYPE_ALIASES,
} from './apiCatalog/index.js';

const PSEUDO_ENTRIES = new Set(['ClientScriptTypes', 'globals', 'ServerRuntime', 'ScriptIncludePatterns']);

// Used when a name is missing from the catalog data but is certainly one side only.
const CLIENT_ONLY = new Set(['g_form', 'g_user', 'g_list', 'g_menu', 'g_navigation', 'g_modal', 'GlideAjax', 'GlideDialogWindow', 'GlideModal']);
const SERVER_ONLY = new Set(['gs', 'current', 'previous', 'GlideAggregate', 'GlideDateTime', 'GlideSystem', 'GlideRecordSecure', 'GlideQuery', 'RESTMessageV2', 'SOAPMessageV2']);
// Exists on both sides in practice (the display business rule hands g_scratchpad to the form).
const BOTH_SIDES = new Set(['g_scratchpad', 'JSON']);
// Generic words that are catalog globals on one side but ordinary locals or browser globals on the other.
const AMBIGUOUS = new Set(['answer', 'request', 'response', 'event', 'parm1', 'parm2', 'template', 'email', 'Workflow']);

const OBJECT_MEMBERS = new Set(['prototype', 'call', 'apply', 'bind', 'toString', 'valueOf', 'constructor', 'hasOwnProperty', 'length']);

const SIDE_LABEL = { client: 'client-side (browser)', server: 'server-side' };

const identifierSidesOf = (name) => {
  if (BOTH_SIDES.has(name)) return ['client', 'server'];
  if (AMBIGUOUS.has(name)) return [];
  const sides = sidesOf(name).filter((s) => !PSEUDO_ENTRIES.has(name));
  if (sides.length) return sides;
  if (CLIENT_ONLY.has(name)) return ['client'];
  if (SERVER_ONLY.has(name)) return ['server'];
  return [];
};

// Variable types are kept per binding (the function scope that declares the name),
// so `gr` can be a GlideAggregate in one function and a GlideRecord in the next.
const bindingKey = (scope, name) => `${scope}:${name}`;

/** { typeAt(name, index), declaredAt(name, index) } over the masked source. */
function inferVariableTypes(masked, side) {
  const scopes = buildScopes(masked);
  const types = new Map();
  const typeAt = (name, index) => types.get(bindingKey(scopes.bindingAt(name, index), name)) || null;
  // Name offset inside a match: the match may start with `var `.
  const nameIndex = (m) => m.index + m[0].indexOf(m[1]);
  for (const m of masked.matchAll(/(?<![.\w$])(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$.]*)\s*\(/g)) {
    const className = m[2].split('.').pop();
    if (getApi(className, side)) types.set(bindingKey(scopes.bindingAt(m[1], nameIndex(m)), m[1]), className);
  }
  // var cond = gr.addQuery(...);  -> type of the declared return value
  for (const m of masked.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const receiverApi = resolveReceiver(m[2], typeAt(m[2], m.index + m[0].indexOf(m[2], m[0].indexOf('='))), side);
    const hit = receiverApi && findMethod(receiverApi, m[3], side);
    const returns = hit?.method.returns;
    if (returns && getApi(returns, side)) types.set(bindingKey(scopes.bindingAt(m[1], nameIndex(m)), m[1]), returns);
  }
  return { typeAt, declaredAt: (name, index) => scopes.resolve(name, index) !== null };
}

function resolveReceiver(name, typeName, side) {
  if (typeName) return getApi(typeName, side);
  if (side === 'server' && GLOBAL_TYPE_ALIASES[name]) return getApi(GLOBAL_TYPE_ALIASES[name], side);
  if (PSEUDO_ENTRIES.has(name)) return null;
  return getApi(name, side);
}

/**
 * @param {string} code
 * @param {{side: 'client'|'server', scoped?: boolean, ui?: string[]}} options
 *   `ui` lists the client UIs the script must support, e.g. ['portal', 'workspace'].
 */
export function checkApiUsage(code, { side, scoped = false, ui = [] } = {}) {
  if (!code || !code.trim() || !side) return [];

  const masked = maskNonCode(code);
  const maskedLines = masked.split('\n');
  const rawLines = code.split('\n');
  const { typeAt, declaredAt } = inferVariableTypes(masked, side);
  const other = side === 'client' ? 'server' : 'client';
  const lineStarts = [];
  maskedLines.reduce((offset, text) => {
    lineStarts.push(offset);
    return offset + text.length + 1;
  }, 0);

  const findings = [];
  const seen = new Set();
  // A whole API being discouraged is reported once, not once per call.
  const reportedOnce = new Set();
  const add = (line, ruleId, severity, message, suggestion, onceKey = null) => {
    if (onceKey) {
      if (reportedOnce.has(onceKey)) return;
      reportedOnce.add(onceKey);
    }
    const key = `${line}|${ruleId}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ ruleId, severity, line, lineText: (rawLines[line - 1] || '').trim(), message, suggestion });
  };

  maskedLines.forEach((text, index) => {
    const line = index + 1;
    const at = lineStarts[index];

    // `new Thing(` where Thing only exists on the other side.
    for (const m of text.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (declaredAt(name, at + m.index)) continue;
      const sides = identifierSidesOf(name);
      if (sides.length && !sides.includes(side)) {
        add(
          line,
          'api-wrong-side',
          'high',
          `${name} is a ${SIDE_LABEL[other]} API and does not exist in ${SIDE_LABEL[side]} scripts.`,
          wrongSideAdvice(name, side)
        );
      }
    }

    // receiver.member, with or without a call.
    for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*(\()?/g)) {
      const [, receiver, member, paren] = m;
      const isCall = Boolean(paren);
      const where = at + m.index;
      const typeName = typeAt(receiver, where);
      const isDeclared = declaredAt(receiver, where);

      if (!typeName && !isDeclared) {
        const sides = identifierSidesOf(receiver);
        if (sides.length && !sides.includes(side)) {
          add(
            line,
            'api-wrong-side',
            'high',
            `${receiver} is a ${SIDE_LABEL[other]} API and does not exist in ${SIDE_LABEL[side]} scripts.`,
            wrongSideAdvice(receiver, side)
          );
          continue;
        }
      }

      // A declared local shadows a catalog global (but not a typed `new X()` variable).
      if (isDeclared && !typeName && !(side === 'server' && GLOBAL_TYPE_ALIASES[receiver])) continue;

      const api = resolveReceiver(receiver, typeName, side);
      if (!api || !isCall || OBJECT_MEMBERS.has(member)) continue;

      const hit = findMethod(api, member, side);
      if (!hit) {
        if (!api.methods.length && !api.properties.length) continue; // dynamic object such as g_scratchpad
        if (api.propertySet.has(member)) continue;
        const near = closest(member, allMethodNames(api, side));
        if (isComplete(api, side)) {
          add(
            line,
            'api-unknown-method',
            'high',
            `${receiver}.${member}() does not exist on ${api.name}.`,
            near ? `Did you mean ${near}()? Check with lookup_api("${api.name}.${near}").` : `See lookup_api("${api.name}") for the real methods.`
          );
        } else if (near) {
          // Within two edits of a real method it is almost certainly a typo, and it would throw at runtime.
          const typo = editDistance(member.toLowerCase(), near.toLowerCase()) <= 2;
          add(
            line,
            'api-unknown-method',
            typo ? 'high' : 'medium',
            `${receiver}.${member}() is not a known ${api.name} method; the closest is ${near}().`,
            `Likely a typo or an invented method. Verify with lookup_api("${api.name}.${near}") before using it.`
          );
        } else {
          add(
            line,
            'api-unverified-method',
            'low',
            `${receiver}.${member}() is not in the verified ${api.name} catalog.`,
            `It may still exist; confirm it in the ServiceNow docs (lookup_api("${api.name}") lists what is verified).`
          );
        }
        continue;
      }

      const { method, owner } = hit;
      if (method.deprecated) {
        // Methods that share one reason (client GlideRecord) are listed once per API.
        const shared = owner.methods.filter((x) => x.deprecated === method.deprecated).length > 2;
        add(
          line,
          'api-deprecated',
          'medium',
          shared ? `${owner.name} is deprecated or discouraged here (${method.name}() and others).` : `${owner.name}.${method.name}() is deprecated or discouraged.`,
          String(method.deprecated),
          shared ? `dep|${owner.name}|${method.deprecated}` : null
        );
      }
      if (side === 'server') {
        if (scoped && method.globalOnly) {
          add(line, 'api-scope-mismatch', 'high', `${owner.name}.${method.name}() works only in the global scope, but this is a scoped application.`, method.notes || 'Use a scoped-safe alternative.');
        } else if (!scoped && method.scopedOnly) {
          add(line, 'api-scope-mismatch', 'medium', `${owner.name}.${method.name}() is available only in scoped applications.`, method.notes || 'Check the scope of this script.');
        }
      } else if (method.unsupportedIn?.length || owner.unsupportedIn?.length) {
        const unsupported = [...new Set([...(method.unsupportedIn || []), ...(owner.unsupportedIn || [])])];
        const hitUi = unsupported.filter((u) => ui.includes(u));
        if (hitUi.length) {
          add(line, 'api-unsupported-ui', 'high', `${owner.name}.${method.name}() is not supported in ${hitUi.join(', ')}.`, method.notes || 'Use a supported alternative.');
        } else if (unsupported.length) {
          add(
            line,
            'api-unsupported-ui',
            'low',
            `${owner.name}.${method.name}() is not supported in ${unsupported.join(', ')}.`,
            'Fine for classic forms; avoid it if this script must run in those UIs.',
            `ui|${owner.name}|${unsupported.join(',')}`
          );
        }
      }
    }
  });

  const order = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
}

function wrongSideAdvice(name, side) {
  if (side === 'server') {
    if (name === 'g_form' || name === 'g_user' || name === 'g_navigation') return `${name} exists only in the browser. On the server read values from \`current\` / a GlideRecord, and use gs.getUser() for the user.`;
    if (name === 'GlideAjax') return 'GlideAjax calls a Script Include from the browser. On the server call the Script Include directly: new MyInclude().method().';
    return `${name} only exists in the browser. Move this logic to client-side code or pass the data through a GlideAjax call.`;
  }
  if (name === 'gs' || name === 'GlideSystem') return 'gs does not exist in the browser. Use g_user for the user, getMessage() for messages, or call a Script Include with GlideAjax.';
  if (name === 'current' || name === 'previous') return '`current` is a server-side Business Rule variable. In a client script use g_form to read the form, or GlideAjax to read other records.';
  return `${name} runs only on the server. Put this logic in a client-callable Script Include and call it with GlideAjax.`;
}
