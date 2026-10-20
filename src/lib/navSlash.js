// Slash commands typed into ServiceNow's own navigator filter ("/tn incident", "/br my rule" ...).
// Pure: decides whether a keystroke in an input is one of those, so it can be unit tested.

/** True for the application navigator's filter box: `input#filter` with a "Filter" placeholder (classic and Polaris menus). */
export function isNavFilter({ tag = '', id = '', placeholder = '', type = 'text' } = {}) {
  return String(tag).toLowerCase() === 'input' && id === 'filter' && /^filter/i.test(String(placeholder).trim()) && ['text', 'search', ''].includes(String(type).toLowerCase());
}

/** The slash command to run for this keystroke in this field, or '' to leave the key alone. */
export function navSlashQuery({ field, key, value, isComposing = false, shiftKey = false, ctrlKey = false, altKey = false, metaKey = false } = {}) {
  if (key !== 'Enter' || isComposing || shiftKey || ctrlKey || altKey || metaKey) return '';
  if (!isNavFilter(field || {})) return '';
  const text = String(value ?? '').trim();
  return /^\/[a-z]/i.test(text) ? text : '';
}
