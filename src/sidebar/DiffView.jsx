import React from 'react';

/** Renders collapseDiff() rows. Text nodes only; nothing here is parsed as HTML. */
export function DiffView({ rows }) {
  if (!rows?.length) return <div className="msb-panel__empty">No differences.</div>;
  return (
    <pre className="msb-diff">
      {rows.map((row, i) => {
        if (row.type === 'gap') {
          return (
            <span key={i} className="msb-diff__line msb-diff__line--gap">
              {`... ${row.count} unchanged line${row.count === 1 ? '' : 's'} ...`}
            </span>
          );
        }
        const mark = row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' ';
        return (
          <span key={i} className={`msb-diff__line msb-diff__line--${row.type}`}>
            {`${mark} ${row.value}`}
          </span>
        );
      })}
    </pre>
  );
}

/** A list of changed fields, each expandable to its diff. */
export function FieldChanges({ changes }) {
  if (!changes.length) return <div className="msb-panel__empty">No differences found.</div>;
  return changes.map((change) => (
    <details key={change.name} className="msb-panel__result">
      <summary className="msb-panel__result-toggle">{change.name}</summary>
      <div className="msb-panel__result-body">
        {change.rows.length ? (
          <DiffView rows={change.rows} />
        ) : (
          <div className="msb-panel__hint">Whitespace-only change.</div>
        )}
      </div>
    </details>
  ));
}
