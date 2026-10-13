import React, { useEffect, useRef, useState } from 'react';
import { appendCapped } from '../lib/logTail.js';
import { redactSecrets } from '../providers/redact.js';

const LEVEL_NAMES = { 0: 'info', 1: 'warn', 2: 'error' };

/** Live system log. Polls while open and running; stops when closed. */
export default function LogTailPanel({ onClose, services, onAskAi }) {
  const [level, setLevel] = useState('all');
  const [contains, setContains] = useState('');
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);
  const tailRef = useRef(null);
  const listRef = useRef(null);

  function stop() {
    tailRef.current?.stop();
    tailRef.current = null;
    setRunning(false);
  }

  function start() {
    stop();
    setError(null);
    try {
      tailRef.current = services.startLogTail({
        level,
        contains,
        onRows: (rows) => setLines((prev) => appendCapped(prev, rows)),
        onError: (err) => setError(err.message),
      });
      setRunning(true);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => () => tailRef.current?.stop(), []);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);

  const asText = () =>
    lines.map((r) => `${r.sys_created_on} [${LEVEL_NAMES[r.level] || r.level}] ${r.source}: ${r.message}`).join('\n');

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>Live log</strong>
        <button
          onClick={() => {
            stop();
            onClose();
          }}
          aria-label="Close"
        >
          {'\u2715'}
        </button>
      </div>

      <div className="msb-panel__form">
        <div className="msb-panel__checks">
          <select value={level} onChange={(e) => setLevel(e.target.value)} disabled={running} aria-label="Level">
            <option value="all">All levels</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
          </select>
          <input
            value={contains}
            onChange={(e) => setContains(e.target.value)}
            disabled={running}
            placeholder="Message contains"
            aria-label="Message contains"
          />
        </div>
        <div className="msb-panel__actions">
          {running ? (
            <button className="msb-panel__run" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="msb-panel__run" onClick={start}>
              Start
            </button>
          )}
          <button className="msb-panel__secondary" onClick={() => setLines([])} disabled={!lines.length}>
            Clear
          </button>
          <button
            className="msb-panel__secondary"
            onClick={() => navigator.clipboard?.writeText(asText())}
            disabled={!lines.length}
          >
            Copy
          </button>
          <button
            className="msb-panel__secondary"
            onClick={() => onAskAi(redactSecrets(asText()).slice(-9000))}
            disabled={!lines.length}
          >
            Ask AI
          </button>
        </div>
      </div>

      {running && !error && <div className="msb-panel__hint">Watching the system log. Polls every few seconds.</div>}
      {error && <div className="msb-panel__error">{error}</div>}

      <div className="msb-log" ref={listRef}>
        {!lines.length && <div className="msb-panel__empty">{running ? 'Waiting for entries...' : 'Not started.'}</div>}
        {lines.map((r) => (
          <div key={r.sys_id} className={`msb-log__line msb-log__line--${LEVEL_NAMES[r.level] || 'info'}`}>
            <span className="msb-log__time">{String(r.sys_created_on).slice(11)}</span>
            <span className="msb-log__source">{r.source}</span>
            <span className="msb-log__msg">{r.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
