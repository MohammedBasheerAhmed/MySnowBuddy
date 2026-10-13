// Gives every form control in the extension UI a name and an accessible label.
// The UI is built from many small components; doing it once here keeps them consistent.

let counter = 0;

function labelFor(control) {
  const wrapping = control.closest('label');
  const text =
    control.getAttribute('aria-label') ||
    control.getAttribute('title') ||
    control.getAttribute('placeholder') ||
    (wrapping ? wrapping.textContent : '') ||
    control.getAttribute('name');
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function fix(root) {
  root.querySelectorAll('input, textarea, select').forEach((control) => {
    if (!control.getAttribute('name')) {
      counter += 1;
      control.setAttribute('name', `msb-field-${counter}`);
    }
    if (control.type === 'hidden') return;
    const hasLabel = control.getAttribute('aria-label') || control.getAttribute('aria-labelledby') || control.closest('label');
    if (!hasLabel) {
      const text = labelFor(control);
      if (text) control.setAttribute('aria-label', text);
    }
  });
}

export function watchFormControls(root) {
  let queued = false;
  const run = () => {
    queued = false;
    fix(root);
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(root, { childList: true, subtree: true });
  fix(root);
}
