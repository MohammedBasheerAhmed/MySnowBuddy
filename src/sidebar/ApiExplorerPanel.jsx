import React, { useMemo, useState } from 'react';
import { ALL_APIS, searchApis, catalogStats } from '../lib/apiCatalog/index.js';
import Icon from './Icon.jsx';

const SIDE_FILTERS = [
  ['all', 'All'],
  ['client', 'Client'],
  ['server', 'Server'],
];

function MethodRow({ api, m }) {
  const [copied, setCopied] = useState(false);
  const flags = [];
  if (m.deprecated) flags.push(['bad', 'Deprecated']);
  if (m.static) flags.push(['neutral', 'static']);
  if (m.scopedOnly) flags.push(['neutral', 'scoped only']);
  if (m.globalOnly) flags.push(['warn', 'global only']);
  (m.unsupportedIn || []).forEach((u) => flags.push(['warn', `not in ${u}`]));

  function copy() {
    if (!m.example) return;
    navigator.clipboard?.writeText(m.example).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="msb-api__method">
      <div className="msb-api__sig">
        <code>{m.sig || `${m.name}()`}</code>
        {m.returns && <span className="msb-api__returns">{m.returns}</span>}
      </div>
      {flags.length > 0 && (
        <div className="msb-api__flags">
          {flags.map(([tone, label]) => (
            <span key={label} className={`msb-api__flag msb-api__flag--${tone}`}>
              {label}
            </span>
          ))}
        </div>
      )}
      {m.summary && <div className="msb-api__text">{m.summary}</div>}
      {m.deprecated && <div className="msb-api__text msb-api__text--bad">{m.deprecated}</div>}
      {m.notes && <div className="msb-api__note">{m.notes}</div>}
      {m.example && (
        <div className="msb-api__example">
          <pre>{m.example}</pre>
          <button type="button" onClick={copy} aria-label={`Copy ${api.name}.${m.name} example`}>
            <Icon name={copied ? 'check' : 'copy'} size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

function ApiCard({ api, defaultOpen, focusMethod }) {
  const methods = focusMethod ? api.methods.filter((m) => m.name === focusMethod) : api.methods;
  return (
    <details className="msb-api__card" open={defaultOpen}>
      <summary>
        <span className="msb-api__name">{api.name}</span>
        <span className={`msb-api__side msb-api__side--${api.side}`}>{api.side}</span>
        <span className="msb-api__count">{api.methods.length} methods</span>
        <Icon name="chevron" size={12} className="msb-api__chev" />
      </summary>
      <div className="msb-api__body">
        {api.summary && <p className="msb-api__text">{api.summary}</p>}
        {api.instantiate && (
          <p className="msb-api__text">
            <code>{api.instantiate}</code>
          </p>
        )}
        {api.unsupportedIn?.length > 0 && <p className="msb-api__text msb-api__text--bad">Not supported in {api.unsupportedIn.join(', ')}.</p>}
        {!api.complete && <p className="msb-api__hint">This list is verified but not exhaustive. A method missing here may still exist.</p>}
        {api.properties.map((p) => (
          <div key={p.name} className="msb-api__method">
            <div className="msb-api__sig">
              <code>.{p.name}</code>
              {p.type && <span className="msb-api__returns">{p.type}</span>}
            </div>
            {p.summary && <div className="msb-api__text">{p.summary}</div>}
          </div>
        ))}
        {methods.map((m) => (
          <MethodRow key={m.name + (m.static ? '-s' : '')} api={api} m={m} />
        ))}
      </div>
    </details>
  );
}

/** Browse and search the verified client and server API catalog the agent is checked against. */
export default function ApiExplorerPanel({ onClose, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery);
  const [side, setSide] = useState('all');
  const stats = useMemo(() => catalogStats(), []);

  const view = useMemo(() => {
    const filter = side === 'all' ? undefined : side;
    if (!query.trim()) {
      return { cards: ALL_APIS.filter((a) => !filter || a.side === filter).map((api) => ({ api })), searched: false };
    }
    const hits = searchApis(query, { side: filter, limit: 60 });
    const byApi = new Map();
    hits.forEach((h) => {
      const entry = byApi.get(h.api) || { api: h.api, methods: new Set() };
      if (h.method) entry.methods.add(h.method.name);
      byApi.set(h.api, entry);
    });
    return {
      cards: [...byApi.values()].map(({ api, methods }) => ({ api, focus: methods.size === 1 && !api.name.toLowerCase().includes(query.trim().toLowerCase()) ? [...methods][0] : null })),
      searched: true,
    };
  }, [query, side]);

  return (
    <div className="msb-panel">
      <div className="msb-panel__header">
        <strong>API explorer</strong>
        <button onClick={onClose} aria-label="Close">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="msb-panel__form">
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search classes and methods: GlideRecord, setMandatory, addQuery..."
          spellCheck={false}
        />
        <div className="msb-seg" role="tablist" aria-label="Where the API runs">
          {SIDE_FILTERS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={side === id} className={side === id ? 'msb-seg__on' : ''} onClick={() => setSide(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="msb-panel__hint">
          {stats.apis} APIs, {stats.methods} verified methods. The agent and the script checker use this catalog, so a method not listed here is flagged before a script reaches you.
        </div>
      </div>

      <div className="msb-api">
        {view.cards.length === 0 && <div className="msb-panel__empty">Nothing in the catalog matches "{query}".</div>}
        {view.cards.map(({ api, focus }) => (
          <ApiCard key={`${api.side}-${api.name}`} api={api} defaultOpen={view.searched && view.cards.length <= 3} focusMethod={focus} />
        ))}
      </div>
    </div>
  );
}
