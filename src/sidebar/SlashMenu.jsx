import React, { useEffect, useRef } from 'react';
import { usage } from '../lib/slashCatalog.js';
import { trusted } from './trusted.js';

/**
 * The suggestions above the chat box while the text is "/word". Focus stays in the textarea (it is the combobox that owns this
 * listbox through aria-controls and aria-activedescendant), so the rows are never focused themselves.
 * With a bare "/" every command shows under its group; once letters narrow the list it is flat, best match first.
 */
export default function SlashMenu({ id, items, active, grouped, onPick, onHover }) {
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);

  const option = (cmd, index) => (
    <div
      key={cmd.verb}
      id={`${id}-opt-${index}`}
      role="option"
      aria-selected={index === active}
      className={index === active ? 'msb-slash__item msb-slash__item--active' : 'msb-slash__item'}
      // mousedown, not click: the textarea must keep focus, and a click would first blur it.
      onMouseDown={trusted((e) => {
        e.preventDefault();
        onPick(cmd);
      })}
      onMouseMove={(e) => {
        if ((e.movementX || e.movementY) && index !== active) onHover(index);
      }}
    >
      <code className="msb-slash__verb">{usage(cmd)}</code>
      <span className="msb-slash__desc">{cmd.desc}</span>
      {cmd.via && <span className="msb-slash__via">{cmd.via}</span>}
    </div>
  );

  let body;
  if (grouped) {
    const groups = [];
    items.forEach((cmd, index) => {
      let last = groups[groups.length - 1];
      if (!last || last.title !== cmd.group) {
        last = { title: cmd.group, rows: [] };
        groups.push(last);
      }
      last.rows.push(option(cmd, index));
    });
    body = groups.map((group) => (
      <div key={group.title} role="group" aria-label={group.title}>
        <div className="msb-slash__group" aria-hidden="true">
          {group.title}
        </div>
        {group.rows}
      </div>
    ));
  } else {
    body = items.map(option);
  }

  return (
    <div className="msb-slash" ref={listRef}>
      {/* A scrolling region must be focusable. The box keeps the focus and drives the list with the arrow keys, and Tab in the box
          completes a command while the list is open, so in practice the list is never tabbed to (it sits after the box in the DOM). */}
      <div className="msb-slash__list" id={id} role="listbox" aria-label="Commands" tabIndex={0}>
        {body}
      </div>
      <div className="msb-slash__foot" aria-hidden="true">
        <kbd>↑</kbd>
        <kbd>↓</kbd> choose <kbd>Tab</kbd> complete <kbd>Esc</kbd> close
      </div>
    </div>
  );
}
