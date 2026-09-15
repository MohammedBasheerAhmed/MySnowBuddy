// Ad-hoc REST request runner used by the REST Builder panel.
//
// SECURITY MODEL
// --------------
// This intentionally only speaks to the instance the user is already on:
//   * The path must be a same-origin relative path beginning with "/".
//   * Absolute URLs, protocol-relative URLs ("//evil.com") and traversal
//     sequences are rejected outright.
// Without this, a REST builder is a confused-deputy: page-supplied input
// could make the extension issue authenticated requests to arbitrary hosts,
// or leak the instance session token off-origin.

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_RESPONSE_CHARS = 200000;

// Headers a caller must not be able to set: they either control the security
// context of the request or would let a request be redirected off-origin.
const BLOCKED_HEADERS = ['host', 'origin', 'referer', 'cookie', 'x-usertoken', 'authorization'];

export function validatePath(rawPath) {
  const path = (rawPath || '').trim();

  if (!path) throw new Error('Enter a request path, for example /api/now/table/incident');
  if (!path.startsWith('/')) {
    throw new Error('Path must be relative and start with "/". Absolute URLs are not allowed.');
  }
  if (path.startsWith('//')) {
    throw new Error('Protocol-relative URLs ("//host") are not allowed.');
  }
  if (path.includes('..')) {
    throw new Error('Path traversal ("..") is not allowed.');
  }

  // Resolve against the current origin and confirm it did not escape it.
  const resolved = new URL(path, window.location.origin);
  if (resolved.origin !== window.location.origin) {
    throw new Error('Request must stay on the current instance origin.');
  }

  return resolved.pathname + resolved.search;
}

function sanitizeHeaders(headers) {
  const safe = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    const name = String(key).trim();
    if (!name) return;
    if (BLOCKED_HEADERS.includes(name.toLowerCase())) return;
    safe[name] = String(value);
  });
  return safe;
}

/**
 * Execute a REST call against the current instance using the user's own
 * session. Never escalates privilege: the instance still applies ACLs.
 *
 * @returns {Promise<{status:number, ok:boolean, durationMs:number, contentType:string, body:string, json:any}>}
 */
export async function runRestRequest({ method = 'GET', path, body = '', headers = {}, csrfToken = '' }) {
  const upperMethod = String(method).toUpperCase();
  if (!ALLOWED_METHODS.includes(upperMethod)) {
    throw new Error(`Unsupported method "${method}".`);
  }

  const safePath = validatePath(path);
  const requestHeaders = {
    Accept: 'application/json',
    ...sanitizeHeaders(headers),
  };

  const hasBody = upperMethod !== 'GET' && upperMethod !== 'DELETE' && body && body.trim();
  if (hasBody) {
    requestHeaders['Content-Type'] = requestHeaders['Content-Type'] || 'application/json';
    // Fail fast on malformed JSON rather than letting the instance return a
    // confusing 400.
    if (requestHeaders['Content-Type'].includes('application/json')) {
      try {
        JSON.parse(body);
      } catch (err) {
        throw new Error(`Request body is not valid JSON: ${err.message}`);
      }
    }
  }

  // State-changing verbs need the instance CSRF token.
  if (upperMethod !== 'GET' && csrfToken) {
    requestHeaders['X-UserToken'] = csrfToken;
  }

  const started = performance.now();
  const response = await fetch(safePath, {
    method: upperMethod,
    credentials: 'same-origin',
    headers: requestHeaders,
    body: hasBody ? body : undefined,
  });
  const durationMs = Math.round(performance.now() - started);

  const contentType = response.headers.get('content-type') || '';
  let text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) {
    text = `${text.slice(0, MAX_RESPONSE_CHARS)}\n... [truncated]`;
  }

  let json = null;
  if (contentType.includes('application/json')) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    durationMs,
    contentType,
    body: json ? JSON.stringify(json, null, 2) : text,
    json,
  };
}

/** Generate an equivalent server-side RESTMessageV2 snippet for the request. */
export function toRestMessageSnippet({ method = 'GET', path, body = '' }) {
  const upper = String(method).toUpperCase();
  const lines = [
    "var request = new sn_ws.RESTMessageV2();",
    `request.setHttpMethod('${upper}');`,
    "request.setEndpoint(gs.getProperty('glide.servlet.uri') + " +
      `'${(path || '').replace(/^\//, '')}');`,
    "request.setRequestHeader('Accept', 'application/json');",
  ];

  if (upper !== 'GET' && upper !== 'DELETE' && body.trim()) {
    lines.push("request.setRequestHeader('Content-Type', 'application/json');");
    lines.push(`request.setRequestBody(${JSON.stringify(body)});`);
  }

  lines.push(
    '',
    '// Supply credentials via a stored Basic Auth profile or MID server;',
    '// never hardcode a username/password in the script.',
    "// request.setAuthenticationProfile('basic', '<profile_sys_id>');",
    '',
    'var response = request.execute();',
    "gs.info('Status: ' + response.getStatusCode());",
    "gs.info('Body: ' + response.getBody());"
  );

  return lines.join('\n');
}
