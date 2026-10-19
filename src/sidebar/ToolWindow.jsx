import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { clampRect, resizeRect, MIN_WINDOW } from '../lib/toolWindow.js';

const RECTS_KEY = 'mysnowbuddy_window_rects';

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

/** Saved size and place per tool, so each one reopens where it was left. */
async function loadRect(name) {
  try {
    const res = await chrome.storage.local.get(RECTS_KEY);
    return res[RECTS_KEY]?.[name] || null;
  } catch {
    return null;
  }
}

async function saveRect(name, rect) {
  try {
    const res = await chrome.storage.local.get(RECTS_KEY);
    await chrome.storage.local.set({ [RECTS_KEY]: { ...(res[RECTS_KEY] || {}), [name]: rect } });
  } catch {
    // Storage unavailable (extension reloaded); the window just does not remember.
  }
}

/**
 * A floating, draggable, resizable window for one tool panel. It lives over the page (not inside the
 * sidebar), so a tool can sit next to the form it is about while the chat stays closed or elsewhere.
 * The panel inside keeps its own header, so the window chrome is only the drag strip and window buttons.
 */
export default function ToolWindow({ name, title, defaultRect, z, onFocus, onClose, onDock, children }) {
  const [rect, setRect] = useState(() => clampRect(defaultRect, viewport()));
  const [maximized, setMaximized] = useState(false);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const restoreRef = useRef(null);

  // A remembered place wins over the computed default, once it has loaded.
  useEffect(() => {
    let live = true;
    loadRect(name).then((saved) => {
      if (live && saved) setRect(clampRect(saved, viewport()));
    });
    return () => {
      live = false;
    };
  }, [name]);

  // Keep the window reachable when the browser window shrinks.
  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r, viewport()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function startGesture(event, mode) {
    if (event.button !== 0 || maximized) return;
    // The header's own buttons are not a drag handle.
    if (mode === 'move' && event.target.closest('button')) return;
    event.preventDefault();
    onFocus?.();
    const origin = { x: event.clientX, y: event.clientY, rect: rectRef.current };
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);

    const onMove = (e) => {
      const dx = e.clientX - origin.x;
      const dy = e.clientY - origin.y;
      setRect(
        mode === 'move'
          ? clampRect({ ...origin.rect, x: origin.rect.x + dx, y: origin.rect.y + dy }, viewport())
          : resizeRect(origin.rect, mode, dx, dy, viewport())
      );
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      saveRect(name, rectRef.current);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  function toggleMaximize() {
    if (maximized) {
      setMaximized(false);
      if (restoreRef.current) setRect(restoreRef.current);
    } else {
      restoreRef.current = rectRef.current;
      setMaximized(true);
    }
  }

  // z is this window's rank among the open windows (0 = lowest): above the sidebar, below the palette.
  const stack = `calc(var(--msb-z) - 1 + ${z})`;
  const style = maximized
    ? { left: 12, top: 12, width: 'calc(100vw - 24px)', height: 'calc(100vh - 24px)', zIndex: stack }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: stack };

  return (
    <div
      className={`msb-win${maximized ? ' msb-win--max' : ''}`}
      style={style}
      role="dialog"
      aria-label={title}
      onPointerDownCapture={onFocus}
    >
      <div className="msb-win__bar" onPointerDown={(e) => startGesture(e, 'move')} onDoubleClick={toggleMaximize}>
        <span className="msb-win__grip" aria-hidden="true" />
        <span className="msb-win__title">{title}</span>
        <span className="msb-win__actions">
          {onDock && (
            <button type="button" onClick={onDock} title="Dock to the sidebar" aria-label="Dock to the sidebar">
              <Icon name="dock" size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={toggleMaximize}
            title={maximized ? 'Restore' : 'Maximize'}
            aria-label={maximized ? 'Restore' : 'Maximize'}
          >
            <Icon name={maximized ? 'minimize' : 'maximize'} size={13} />
          </button>
          <button type="button" onClick={onClose} title="Close" aria-label="Close">
            <Icon name="close" size={13} />
          </button>
        </span>
      </div>
      <div className="msb-win__body">{children}</div>
      {!maximized && (
        <>
          <div className="msb-win__edge msb-win__edge--e" onPointerDown={(e) => startGesture(e, 'e')} />
          <div className="msb-win__edge msb-win__edge--s" onPointerDown={(e) => startGesture(e, 's')} />
          <div
            className="msb-win__edge msb-win__edge--se"
            onPointerDown={(e) => startGesture(e, 'se')}
            role="separator"
            aria-label="Resize window"
          />
        </>
      )}
    </div>
  );
}

export { MIN_WINDOW };
