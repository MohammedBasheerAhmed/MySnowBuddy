// Lightweight toast notifications rendered inside the extension's Shadow DOM
// root, so feedback works even when the chat sidebar is disabled or closed.

const DEFAULT_TIMEOUT = 4000;

export function createToastHost() {
  const host = document.createElement('div');
  host.className = 'msb-toasts';

  function show(message, { tone = 'info', timeout = DEFAULT_TIMEOUT, action = null } = {}) {
    const toast = document.createElement('div');
    toast.className = `msb-toast msb-toast--${tone}`;

    const text = document.createElement('span');
    text.className = 'msb-toast__text';
    text.textContent = message;
    toast.appendChild(text);

    if (action && typeof action.onClick === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msb-toast__action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        action.onClick();
        dismiss();
      });
      toast.appendChild(btn);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'msb-toast__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '\u00d7';
    close.addEventListener('click', () => dismiss());
    toast.appendChild(close);

    host.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('msb-toast--in'));

    let timer = timeout ? setTimeout(dismiss, timeout) : null;

    function dismiss() {
      if (timer) clearTimeout(timer);
      timer = null;
      toast.classList.remove('msb-toast--in');
      setTimeout(() => toast.remove(), 180);
    }

    return { dismiss };
  }

  return {
    element: host,
    show,
    info: (msg, opts) => show(msg, { ...opts, tone: 'info' }),
    success: (msg, opts) => show(msg, { ...opts, tone: 'success' }),
    error: (msg, opts) => show(msg, { ...opts, tone: 'error', timeout: 7000 }),
  };
}
