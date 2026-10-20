import React, { useEffect, useState } from 'react';
import { listInstances, addInstance, removeInstance, updateInstance, reorderInstance } from '../content/stores.js';
import { SWATCHES, validColor, resolveColor, classifyEnvironment, looksProd, parseInstanceHost } from '../lib/instances.js';

// Options > Instances: the list the switcher ("/i" in the palette) and the tab tag are built from. A colour is
// optional; production is always drawn red whatever is chosen, so a colour can never make it look safe.

const toneOf = (entry) => (classifyEnvironment(entry.label) || classifyEnvironment(String(entry.host).split('.')[0]))?.tone || 'neutral';

function ColorPicker({ value, onChange, label, className = '' }) {
  const chosen = validColor(value);
  return (
    <div className={`msb-inst__colors ${className}`.trim()} role="radiogroup" aria-label={label}>
      <button type="button" role="radio" aria-checked={!chosen} className="msb-inst__auto" onClick={() => onChange('')} title="Automatic: from the name (red for production)">
        Auto
      </button>
      {SWATCHES.map((swatch) => (
        <button
          key={swatch.id}
          type="button"
          role="radio"
          aria-checked={chosen === swatch.hex}
          aria-label={swatch.name}
          title={swatch.name}
          className="msb-inst__swatch"
          style={{ background: swatch.hex }}
          onClick={() => onChange(swatch.hex)}
        />
      ))}
    </div>
  );
}

function Row({ entry, index, count, onChange, onError }) {
  const [label, setLabel] = useState(entry.label);
  useEffect(() => setLabel(entry.label), [entry.label]);
  const prod = looksProd(entry.label, String(entry.host).split('.')[0]);
  const color = resolveColor({ saved: entry.color, tone: toneOf(entry), host: entry.host });

  const run = (task) =>
    task()
      .then(onChange)
      .catch((err) => onError(err.message));

  const commitLabel = () => {
    if (label.trim() !== entry.label) run(() => updateInstance(entry.id, { label }));
  };

  return (
    <li className="msb-inst__row">
      <span className="msb-inst__dot" style={{ background: color }} aria-hidden="true">
        {String(label || entry.host).charAt(0).toUpperCase()}
      </span>
      <div className="msb-inst__main">
        <input
          className="msb-inst__label"
          value={label}
          maxLength={40}
          aria-label={`Label for ${entry.host}`}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="msb-inst__host">{entry.host}</span>
        {prod && <span className="msb-inst__prod">Production is always red</span>}
      </div>
      <div className="msb-inst__ops">
        <button type="button" disabled={index === 0} aria-label={`Move ${entry.label} up`} onClick={() => run(() => reorderInstance(entry.id, -1))}>
          ↑
        </button>
        <button type="button" disabled={index === count - 1} aria-label={`Move ${entry.label} down`} onClick={() => run(() => reorderInstance(entry.id, 1))}>
          ↓
        </button>
        <button
          type="button"
          aria-label={`Remove ${entry.label}`}
          onClick={() =>
            removeInstance(entry.id)
              .then(() => listInstances())
              .then(onChange)
              .catch((err) => onError(err.message))
          }
        >
          Remove
        </button>
      </div>
      <ColorPicker className="msb-inst__colors--row" value={entry.color} label={`Colour for ${entry.label}`} onChange={(next) => run(() => updateInstance(entry.id, { color: next }))} />
    </li>
  );
}

export default function InstanceManager() {
  const [items, setItems] = useState([]);
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [color, setColor] = useState('');
  const [error, setError] = useState('');
  const [hostTouched, setHostTouched] = useState(false);

  useEffect(() => {
    listInstances().then(setItems).catch(() => {});
  }, []);

  // The format message waits until the field is left: "dev1" is not an error while it is still being typed.
  const hostCheck = hostTouched && host.trim() ? parseInstanceHost(host) : null;

  async function handleAdd(event) {
    event.preventDefault();
    setError('');
    try {
      await addInstance({ label, host, color });
      setItems(await listInstances());
      setLabel('');
      setHost('');
      setHostTouched(false);
      setColor('');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="msb-inst">
      <form className="msb-inst__add" onSubmit={handleAdd}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label (e.g. PROD)" aria-label="New instance label" maxLength={40} />
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onBlur={() => setHostTouched(true)}
          placeholder="prod12345.service-now.com"
          aria-label="New instance host"
          aria-invalid={Boolean(hostCheck?.error)}
          aria-describedby="msb-inst-error"
        />
        <ColorPicker value={color} onChange={setColor} label="Colour for the new instance" />
        <button type="submit">Add</button>
      </form>
      <div id="msb-inst-error" role="alert">
        {(error || hostCheck?.error) && <div className="msb-options__invalid">{error || hostCheck?.error}</div>}
      </div>
      {items.length === 0 ? (
        <p className="msb-options__hint">No instances yet. Open the palette and type /i on an instance to add it, or add one above.</p>
      ) : (
        <ul className="msb-inst__list" aria-label="Known instances">
          {items.map((entry, index) => (
            <Row
              key={entry.id}
              entry={entry}
              index={index}
              count={items.length}
              onChange={(list) => {
                setError('');
                setItems(list);
              }}
              onError={setError}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
