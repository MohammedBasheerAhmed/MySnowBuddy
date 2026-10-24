// Slash commands typed into ServiceNow's own navigator filter ("/tn incident", "/br my rule" ...).
// Pure: decides whether a keystroke in an input is one of those, so it can be unit tested.

/** True for the application navigator's filter box: `input#filter` with a "Filter" placeholder (classic and Polaris menus). */
export function isNavFilter({ tag = '', id = '', placeholder = '', type = 'text' } = {}) {
  return String(tag).toLowerCase() === 'input' && id === 'filter' && /^filter/i.test(String(placeholder).trim()) && ['text', 'search', ''].includes(String(type).toLowerCase());
}

/**
 * The slash command to run for this keystroke in this field, or '' to leave the key alone.
 * Enter submits "/tn incident" and the like. The first "/" typed into an empty filter returns "/", which opens the palette on its
 * list of every command (a module path never starts with a slash, so the filter has no use for it). Shift is allowed on that key:
 * on many layouts "/" is Shift+7.
 */
export function navSlashQuery({ field, key, value, isComposing = false, shiftKey = false, ctrlKey = false, altKey = false, metaKey = false } = {}) {
  if (key === '/' && !isComposing && !ctrlKey && !altKey && !metaKey) return isNavFilter(field || {}) && !String(value ?? '').trim() ? '/' : '';
  if (key !== 'Enter' || isComposing || shiftKey || ctrlKey || altKey || metaKey) return '';
  if (!isNavFilter(field || {})) return '';
  const text = String(value ?? '').trim();
  return /^\/[a-z]/i.test(text) ? text : '';
}
