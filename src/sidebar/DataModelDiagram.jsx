import React, { useEffect, useMemo, useRef, useState } from 'react';
import { layoutMap, describeGraph } from '../lib/dataModel.js';

const ZOOMS = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 2];

const KIND_TEXT = {
  centre: 'this table',
  parent: 'parent table',
  child: 'child table',
  incoming: 'points here',
  outgoing: 'pointed at',
  generic: 'any table',
};

const LEGEND = [
  ['centre', 'This table'],
  ['parent', 'Parent (extends)'],
  ['child', 'Child (extends this)'],
  ['incoming', 'Points at this table'],
  ['outgoing', 'This table points at'],
];

/**
 * The picture of one table: incoming references on the left, the table in the middle (parents above, children below),
 * outgoing references on the right. Drawn by layoutMap (src/lib/dataModel.js); this component only paints it. Click a
 * table (or press Enter on it) to re-centre the map on it. The list view beside it holds the same facts.
 */
export default function DataModelDiagram({ graph, onOpen }) {
  const layout = useMemo(() => layoutMap(graph), [graph]);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState('');
  const scroller = useRef(null);
  const summary = useMemo(() => describeGraph(graph), [graph]);

  // Start with the table itself in view; the side columns are one scroll away on a narrow panel. A tab that was hidden
  // when the picture was drawn has no width yet, so this also runs when the box first gets one.
  const centred = useRef(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    centred.current = false;
    const el = scroller.current;
    const centre = layout.nodes.find((n) => n.kind === 'centre');
    const place = () => {
      if (!el || !centre || centred.current || !el.clientWidth) return;
      centred.current = true;
      el.scrollLeft = Math.max(0, (centre.x + centre.w / 2) * zoomRef.current - el.clientWidth / 2);
      el.scrollTop = Math.max(0, (centre.y + centre.h / 2) * zoomRef.current - el.clientHeight / 2);
    };
    place();
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const watcher = new ResizeObserver(place);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [layout]);

  function fit() {
    const el = scroller.current;
    if (!el) return;
    const wanted = (el.clientWidth - 4) / layout.width;
    // Down to 30%: too small to read, but a whole-picture overview on a narrow panel; zoom in from there.
    setZoom(Math.max(0.3, Math.min(1, Math.floor(wanted * 20) / 20)));
  }
  const step = (dir) => {
    const at = ZOOMS.findIndex((z) => z >= zoom - 0.001);
    setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (at < 0 ? ZOOMS.length - 1 : at) + dir))]);
  };

  const hot = (edge) => hover && (edge.from === hover || edge.to === hover);

  return (
    <div className="msb-dm-diagram">
      <div className="msb-dm-diagram__bar">
        <div className="msb-dm-legend" aria-hidden="true">
          {LEGEND.map(([kind, text]) => (
            <span key={kind} className="msb-dm-legend__item">
              <span className={`msb-dm-swatch msb-dm-swatch--${kind}`} />
              {text}
            </span>
          ))}
        </div>
        <div className="msb-dm-zoom" role="group" aria-label="Zoom">
          <button type="button" className="msb-panel__secondary" onClick={() => step(-1)} disabled={zoom <= ZOOMS[0]} aria-label="Zoom out">
            {'−'}
          </button>
          <span className="msb-dm-zoom__value" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <button type="button" className="msb-panel__secondary" onClick={() => step(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="msb-panel__secondary" onClick={fit}>
            Fit width
          </button>
        </div>
      </div>

      <div ref={scroller} className="msb-dm-diagram__scroll" role="region" aria-label="Diagram of the table, scrollable" tabIndex={0}>
        <svg
          className="msb-dm-svg"
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={summary}
          onMouseLeave={() => setHover('')}
        >
          <defs>
            <marker id="msb-dm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" className="msb-dm-arrowhead" />
            </marker>
            <marker id="msb-dm-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" className="msb-dm-arrowhead msb-dm-arrowhead--hot" />
            </marker>
            <marker id="msb-dm-extends" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="9" markerHeight="9" orient="auto">
              <path d="M 1 1 L 11 6 L 1 11 z" className="msb-dm-extendhead" />
            </marker>
          </defs>

          <g className="msb-dm-edges">
            {layout.edges.map((e) => (
              <g key={e.id} className={`msb-dm-edge msb-dm-edge--${e.kind}${hot(e) ? ' is-hot' : hover ? ' is-dim' : ''}`}>
                <path d={e.d} fill="none" markerEnd={e.arrow === 'extends' ? 'url(#msb-dm-extends)' : e.arrow === 'ref' ? (hot(e) ? 'url(#msb-dm-arrow-hot)' : 'url(#msb-dm-arrow)') : undefined} />
                {e.label && (
                  <text x={e.lx} y={e.ly} textAnchor={e.anchor} className="msb-dm-edge__label">
                    {e.label}
                  </text>
                )}
              </g>
            ))}
          </g>

          <g className="msb-dm-nodes">
            {layout.nodes.map((n) => {
              const kindText = KIND_TEXT[n.kind] || '';
              // The name starts with exactly the words on the box (title, then the line under it), so a speech-input
              // user can say what they see (WCAG 2.5.3); the full table name follows when the title had to be cut.
              const visible = `${n.title} ${n.sub}`.trim();
              const full = n.table ? `${visible}${n.title !== n.table ? ` (${n.table})` : ''}, ${kindText}` : visible;
              const open = () => n.clickable && onOpen(n.table);
              return (
                <g
                  key={n.id}
                  className={`msb-dm-node msb-dm-node--${n.kind}${n.clickable ? ' is-clickable' : ''}${hover === n.id ? ' is-hover' : ''}`}
                  transform={`translate(${n.x} ${n.y})`}
                  role={n.clickable ? 'button' : 'img'}
                  tabIndex={n.clickable ? 0 : undefined}
                  aria-label={n.clickable ? `${full}. Show its map.` : full}
                  onClick={open}
                  onKeyDown={(ev) => {
                    if (n.clickable && (ev.key === 'Enter' || ev.key === ' ')) {
                      ev.preventDefault();
                      open();
                    }
                  }}
                  onMouseEnter={() => setHover(n.id)}
                  onFocus={() => setHover(n.id)}
                  onBlur={() => setHover('')}
                >
                  {/* The box's text must read exactly as the start of the name (axe label-content-name-mismatch): one <text>
                      with a space between the two lines, and no <title> tooltip, whose text would count as well. */}
                  <rect width={n.w} height={n.h} rx="6" />
                  <text>
                    <tspan x="9" y="16" className="msb-dm-node__title">
                      {n.title}
                    </tspan>{' '}
                    <tspan x="9" y="31" className="msb-dm-node__sub">
                      {n.sub}
                    </tspan>
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div className="msb-panel__hint">
        {layout.hidden.incoming + layout.hidden.outgoing + layout.hidden.children > 0
          ? 'Tables that did not fit are in the list view. '
          : ''}
        Click a table to centre the map on it. Scroll sideways to see both sides.
      </div>
    </div>
  );
}
