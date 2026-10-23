import React, { useEffect, useId, useRef, useState } from 'react';
import { copyText } from '../content/quickActions.js';

// Small pieces shared by the Data model map tabs: the table type-ahead and a copy button with a spoken confirmation.

export const errorText = (err) => err?.message || String(err);

/** copy(text, what) puts text on the clipboard and sets `notice` for a moment. */
export function useCopyNotice() {
  const [notice, setNotice] = useState('');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy(text, what) {
    try {
      await copyText(text);
      setNotice(`Copied ${what}`);
    } catch (err) {
      setNotice(`Could not copy: ${errorText(err)}`);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(''), 2600);
  }
  return { notice, copy };
}

/**
 * A table name box with suggestions from the table catalog and sys_db_object. Typing never runs anything; Enter (or a
 * click on a suggestion) calls onSubmit with the name. Arrow keys move through the suggestions, Escape closes them.
 */
export function TablePicker({ label, value, onChange, onSubmit, services, placeholder = 'incident', autoFocus = false }) {
  const id = useId();
  const listId = `${id}-list`;
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const run = useRef(0);

  useEffect(() => {
    const term = String(value || '').trim();
    if (!open || term.length < 1 || !services?.dataModelFindTables) {
      setItems([]);
      return undefined;
    }
    const mine = (run.current += 1);
    const timer = setTimeout(async () => {
      const found = await services.dataModelFindTables(term).catch(() => []);
      if (mine === run.current) {
        setItems(found.slice(0, 8));
        setActive(-1);
      }
    }, 160);
    return () => clearTimeout(timer);
  }, [value, open, services]);

  function pick(name) {
    onChange(name);
    setOpen(false);
    setItems([]);
    onSubmit?.(name);
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown' && items.length) {
      event.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % items.length);
    } else if (event.key === 'ArrowUp' && items.length) {
      event.preventDefault();
      setActive((a) => (a <= 0 ? items.length - 1 : a - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (open && active >= 0 && items[active]) pick(items[active].name);
      else {
        setOpen(false);
        onSubmit?.(String(value || '').trim());
      }
    } else if (event.key === 'Escape' && open && items.length) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="msb-dm-picker">
      <label htmlFor={id} className="msb-dm-picker__label">
        {label}
      </label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {open && items.length > 0 && (
        <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className="msb-dm-picker__list">
          {items.map((t, i) => (
            <li
              key={t.name}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={`msb-dm-picker__item${i === active ? ' is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(t.name);
              }}
            >
              <span className="msb-dm-mono">{t.name}</span>
              {t.label && t.label !== t.name && <span className="msb-dm-muted">{t.label}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A table name that opens its own map when clicked. */
export function TableLink({ name, label, onOpen, title }) {
  return (
    <button type="button" className="msb-dm-tablelink" onClick={() => onOpen(name)} title={title || `Show the map of ${name}`}>
      <span className="msb-dm-mono">{name}</span>
      {label && label !== name && <span className="msb-dm-muted"> {label}</span>}
    </button>
  );
}
