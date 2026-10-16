// ServiceNow evaluates an encoded-query value that starts with "javascript:" as
// server-side script. Any value that came from a model, an MCP client or pasted
// text must pass through here before it is placed in a query.
const INLINE_SCRIPT_RE = /^\s*javascript\s*:/i;

export function assertNoInlineScript(value, label = 'Value') {
  if (INLINE_SCRIPT_RE.test(String(value ?? ''))) {
    throw new Error(`${label} may not start with "javascript:" (it would run as script in a query).`);
  }
  return value;
}

export const hasInlineScript = (value) => INLINE_SCRIPT_RE.test(String(value ?? ''));
