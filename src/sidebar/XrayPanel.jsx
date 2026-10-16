import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { recordPath, describeAction, evaluateCondition, readableCatalogCondition, STATE_LABELS } from '../lib/xray.js';

// Page X-ray panel: what is on the page (form fields, list columns, catalog variables, portal widgets)
// and the logic that controls each item. Data comes from src/content/xray.js (xrayServices).

const copyText = (text) => navigator.clipboard?.writeText(String(text)).catch(() => {});

const COUNT_KEYS = [
  ['clientScripts', 'CS', 'client scripts'],
  ['uiPolicies', 'UP', 'UI policies'],
  ['dataPolicies', 'DP', 'data policies'],
  ['businessRules', 'BR', 'business rules'],
  ['acls', 'ACL', 'field ACLs'],
];

function RecordLink({ table, sysId, children, title }) {
  const href = recordPath(table, sysId);
  if (!href) return <span>{children}</span>;
  return (
    <a className="msb-panel__link" href={href} target="_blank" rel="noopener noreferrer" title={title || `Open in a new tab (${table})`}>
      {children}
    </a>
  );
}

function PathLink({ href, children, title }) {
  return (
    <a className="msb-panel__link" href={href} target="_blank" rel="noopener noreferrer" title={title}>
      {children}
    </a>
  );
}

function Counts({ counts }) {
  const shown = COUNT_KEYS.filter(([key]) => counts?.[key]);
  if (!shown.length) return <span className="msb-xray__none">no logic</span>;
  return (
    <span className="msb-xray__counts">
      {shown.map(([key, short, long]) => (
        <span key={key} className="msb-xray__count" title={`${counts[key]} ${long}`}>
          {short} {counts[key]}
        </span>
      ))}
    </span>
  );
}

function Flags({ live, mandatory, readOnly }) {
  const flags = [];
  if (live?.mandatory || mandatory) flags.push(['mand', 'mandatory']);
  if (live?.readOnly || readOnly) flags.push(['ro', 'read-only']);
  if (live?.visible === false) flags.push(['hidden', 'hidden']);
  return flags.map(([key, text]) => (
    <span key={key} className={`msb-xray__flag msb-xray__flag--${key}`}>
      {text}
    </span>
  ));
}

function Section({ title, children }) {
  return (
    <div className="msb-xray__section">
      <div className="msb-xray__caption">{title}</div>
      {children}
    </div>
  );
}

function CopyButton({ text, label }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="msb-panel__link"
      onClick={() => {
        copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

const unique = (list) => [...new Set(list)];
const matches = (needle, ...values) => values.some((v) => String(v || '').toLowerCase().includes(needle));

// --- Field detail -------------------------------------------------------------------------------

function referenceQualifier(column) {
  const mode = String(column.useReferenceQualifier || '').toLowerCase();
  if (mode === 'dynamic') return column.dynamicRefQual ? `dynamic filter ${column.dynamicRefQual}` : 'dynamic';
  if (mode === 'simple') return column.referenceQualCondition || '';
  return column.referenceQual || column.referenceQualCondition || '';
}

function overrideChanges(o) {
  return [
    o.mandatory !== null && (o.mandatory ? 'mandatory' : 'not mandatory'),
    o.readOnly !== null && (o.readOnly ? 'read-only' : 'editable'),
    o.defaultValue && `default ${o.defaultValue}`,
    o.referenceQual && `reference qualifier ${o.referenceQual}`,
    o.attributes && `attributes ${o.attributes}`,
    o.calculation && 'calculation',
    o.dependent && `dependent on ${o.dependent}`,
    o.display !== null && o.display !== undefined && o.display !== '' && (o.display ? 'display value' : 'not display value'),
  ].filter(Boolean);
}

function NowSection({ data }) {
  if (data.onForm === null) return <div className="msb-panel__hint">Open this form to see the field's live state and why.</div>;
  const kinds = ['readOnly', 'mandatory', 'hidden'].filter((k) => data.causes?.[k]?.length);
  const live = data.live;
  // null = the page could not tell (no g_form method and no markup for it): say so instead of guessing.
  const unknown = [live?.readOnly == null && 'read-only', live?.mandatory == null && 'mandatory', live?.visible == null && 'visible'].filter(Boolean);
  return (
    <Section title="Right now">
      <div className="msb-xray__chips">
        {data.onForm === false ? (
          <span className="msb-xray__flag msb-xray__flag--hidden">not on this form</span>
        ) : live?.mandatory || live?.readOnly || live?.visible === false ? (
          <Flags live={live} />
        ) : unknown.length ? null : (
          <span className="msb-panel__hint">Editable, optional and visible.</span>
        )}
        {data.onForm !== false && unknown.length > 0 && <span className="msb-panel__hint">Unknown: {unknown.join(', ')}.</span>}
      </div>
      {kinds.map((kind) => (
        <div key={kind} className="msb-xray__why">
          <div className="msb-xray__whytitle">Why is it {STATE_LABELS[kind]}?</div>
          <ol className="msb-xray__causes">
            {data.causes[kind].map((cause, i) => (
              <li key={`${cause.kind}-${cause.sysId || i}`}>
                <span className={`msb-xray__conf msb-xray__conf--${cause.confidence}`}>{cause.confidence}</span>
                <RecordLink table={cause.table} sysId={cause.sysId}>
                  {cause.title}
                </RecordLink>
                <div className="msb-panel__hint">{cause.detail}</div>
              </li>
            ))}
          </ol>
        </div>
      ))}
      {data.onForm && (
        <div className="msb-panel__hint">
          State read from {{ g_form: 'g_form', 'g_form+page': 'g_form, with gaps filled from the form markup' }[data.liveSource] || 'the form markup (g_form was not reachable)'}.
        </div>
      )}
    </Section>
  );
}

function DictionarySection({ table, column, overrides }) {
  if (!column) return <div className="msb-panel__hint">No dictionary entry on {table}: a dot-walked field, or a column of another table.</div>;
  const qualifier = referenceQualifier(column);
  const flags = [column.mandatory && 'mandatory', column.readOnly && 'read-only', column.display && 'display value', !column.active && 'inactive'].filter(Boolean);
  const facts = [
    ['Type', `${column.type}${column.reference ? ` to ${column.reference}` : ''}${column.choiceType ? ' with choices' : ''}`],
    column.definedOn !== table && ['Defined on', column.definedOn],
    column.maxLength && ['Max length', column.maxLength],
    column.defaultValue && ['Default', column.defaultValue, true],
    qualifier && ['Ref qualifier', qualifier, true],
    (column.dependentOnField || column.dependent) && ['Depends on', column.dependentOnField || column.dependent],
    column.calculated && ['Calculated', column.calculation || 'yes', true],
    column.attributes && ['Attributes', column.attributes, true],
    flags.length && ['Flags', flags.join(', ')],
  ].filter(Boolean);
  return (
    <Section
      title={
        <>
          Dictionary{' '}
          <RecordLink table="sys_dictionary" sysId={column.sysId}>
            open
          </RecordLink>
        </>
      }
    >
      <dl className="msb-xray__facts">
        {facts.map(([key, value, code]) => (
          <React.Fragment key={key}>
            <dt>{key}</dt>
            <dd>{code ? <code>{value}</code> : value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {overrides.length > 0 && (
        <ul className="msb-xray__items">
          {overrides.map((o) => (
            <li key={o.sysId}>
              <RecordLink table="sys_dictionary_override" sysId={o.sysId}>
                Override on {o.table}
              </RecordLink>
              <div className="msb-panel__hint">{overrideChanges(o).join(', ') || 'no visible change'}</div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function conditionNow(result) {
  if (result === true) return 'true now';
  if (result === false) return 'false now';
  return 'cannot tell from the form';
}

function PolicyItem({ policy, action, role, table, values, conditionText }) {
  const result = values ? evaluateCondition(policy.conditions, values) : null;
  const what = role === 'action' ? describeAction(action) : role === 'condition' ? 'uses this field in its condition' : role === 'rule' ? describeAction(action) : 'its script calls g_form on it';
  const meta = [
    what,
    policy.onLoad === false && 'on change only',
    policy.reverseIfFalse === false && 'no reverse',
    policy.table && table && policy.table !== table && `on ${policy.table}`,
    policy.global === false && policy.view && `view ${policy.view}`,
    policy.enforceUi === false && 'server only',
  ].filter(Boolean);
  return (
    <li>
      <RecordLink table={policy.recordTable} sysId={policy.sysId}>
        {policy.name || '(no description)'}
      </RecordLink>
      <div className="msb-panel__hint">{meta.join(' · ')}</div>
      {policy.conditions && (
        <div className="msb-xray__cond">
          <code>{conditionText || policy.conditions.replace(/\^EQ$/, '')}</code>
          {values && <span className={`msb-xray__now msb-xray__now--${result}`}>{conditionNow(result)}</span>}
        </div>
      )}
    </li>
  );
}

function ClientScriptItem({ script, reasons, table, onChangeOf }) {
  const calls = unique(reasons.filter((r) => r !== 'onChange'));
  const changeOf = onChangeOf ?? script.field;
  const meta = [
    script.type,
    script.type === 'onChange' && changeOf && `of ${changeOf}`,
    script.table && table && script.table !== table && `on ${script.table}`,
    script.uiType === '1' && 'mobile / portal only',
    calls.length && `calls ${calls.join(', ')}`,
  ].filter(Boolean);
  return (
    <li>
      <RecordLink table={script.recordTable} sysId={script.sysId}>
        {script.name || '(no name)'}
      </RecordLink>
      <div className="msb-panel__hint">{meta.join(' · ')}</div>
    </li>
  );
}

function askPrompt(data) {
  const { table, field, column, live, causes, entry } = data;
  const states = live ? ['readOnly', 'mandatory', 'hidden'].filter((k) => causes?.[k]?.length).map((k) => STATE_LABELS[k]) : [];
  const lines = [
    `Explain what controls the field "${field}" on the ${table} form in ServiceNow${states.length ? ` and why it is ${states.join(' and ')} right now` : ''}.`,
    column ? `Dictionary: type ${column.type}${column.reference ? ` to ${column.reference}` : ''}; mandatory ${column.mandatory}; read only ${column.readOnly}; defined on ${column.definedOn}.` : 'No dictionary entry on this table.',
  ];
  if (live) lines.push(`Live state: read-only ${live.readOnly}, mandatory ${live.mandatory}, visible ${live.visible}.`);
  states.forEach((label) => {
    const kind = Object.keys(STATE_LABELS).find((k) => STATE_LABELS[k] === label);
    lines.push(`Candidate causes for ${label}, most likely first (found by MySnowBuddy X-ray):`);
    causes[kind].forEach((c) => lines.push(`- [${c.confidence}] ${c.title}: ${c.detail}`));
  });
  if (entry) {
    const names = (rows, get) => rows.map(get).filter(Boolean).slice(0, 12).join('; ');
    if (entry.clientScripts.length) lines.push(`Client scripts touching it: ${names(entry.clientScripts, (r) => `${r.script.name} (${r.script.type})`)}`);
    if (entry.uiPolicies.length) lines.push(`UI policies: ${names(entry.uiPolicies, (r) => `${r.policy.name} [${r.policy.conditions || 'always'}]`)}`);
    if (entry.businessRules.length) lines.push(`Business rules: ${names(entry.businessRules, (r) => `${r.rule.name} (${r.rule.when})`)}`);
  }
  lines.push('Be brief. For each likely cause, say how to confirm it and how to change it.');
  return lines.join('\n');
}

function FieldDetail({ table, field, services, onAskAi }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [accessMissing, setAccessMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    services
      .xrayFieldReport({ table, field })
      .then((next) => alive && setData(next))
      .catch((err) => alive && setError(err.message || String(err)));
    return () => {
      alive = false;
    };
  }, [table, field, services]);

  if (error) return <div className="msb-panel__error">{error}</div>;
  if (!data) return <div className="msb-xray__detail msb-panel__hint">Loading...</div>;

  const entry = data.entry || { clientScripts: [], uiPolicies: [], dataPolicies: [], businessRules: [], acls: [] };
  const values = data.onForm === null ? null : data.values;
  const fieldAcls = entry.acls;

  return (
    <div className="msb-xray__detail">
      <NowSection data={data} />
      <DictionarySection table={table} column={data.column} overrides={data.overrides} />

      {entry.clientScripts.length > 0 && (
        <Section title={`Client scripts (${entry.clientScripts.length})`}>
          <ul className="msb-xray__items">
            {entry.clientScripts.map((row) => (
              <ClientScriptItem key={row.script.sysId} script={row.script} reasons={row.reasons} table={table} />
            ))}
          </ul>
        </Section>
      )}
      {entry.uiPolicies.length > 0 && (
        <Section title={`UI policies (${entry.uiPolicies.length})`}>
          <ul className="msb-xray__items">
            {entry.uiPolicies.map((row) => (
              <PolicyItem key={`${row.policy.sysId}-${row.role}`} {...row} table={table} values={values} />
            ))}
          </ul>
        </Section>
      )}
      {entry.dataPolicies.length > 0 && (
        <Section title={`Data policies (${entry.dataPolicies.length})`}>
          <ul className="msb-xray__items">
            {entry.dataPolicies.map((row) => (
              <PolicyItem key={`${row.policy.sysId}-${row.role}`} policy={row.policy} action={row.rule} role={row.role} table={table} values={values} />
            ))}
          </ul>
        </Section>
      )}
      {entry.businessRules.length > 0 && (
        <Section title={`Business rules (${entry.businessRules.length})`}>
          <ul className="msb-xray__items">
            {entry.businessRules.map(({ rule, where }) => (
              <li key={rule.sysId}>
                <RecordLink table="sys_script" sysId={rule.sysId}>
                  {rule.name || '(no name)'}
                </RecordLink>
                <div className="msb-panel__hint">
                  {[rule.when, rule.order && `order ${rule.order}`, rule.operations?.length && rule.operations.join('/'), rule.table !== table && `on ${rule.table}`, `uses it in its ${where.join(', ')}`].filter(Boolean).join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`ACLs (${fieldAcls.length} on this field, ${data.tableAcls.length} on the table)`}>
        {fieldAcls.length > 0 && (
          <ul className="msb-xray__items">
            {fieldAcls.map((acl) => (
              <li key={acl.sysId}>
                <RecordLink table="sys_security_acl" sysId={acl.sysId}>
                  {acl.name}
                </RecordLink>
                <div className="msb-panel__hint">{[acl.operation, acl.advanced && 'script', acl.adminOverrides === false && 'admin does not override'].filter(Boolean).join(' · ')}</div>
              </li>
            ))}
          </ul>
        )}
        <div className="msb-xray__actions">
          <button
            type="button"
            className="msb-panel__link"
            onClick={() => {
              if (!services.xrayOpenAccess?.({ table, field, operation: 'write' })) setAccessMissing(true);
            }}
          >
            Check write access in the access debugger
          </button>
        </div>
        {accessMissing && <div className="msb-panel__hint">The access debugger is not available in this build.</div>}
      </Section>

      <div className="msb-xray__actions">
        {data.onForm && (
          <button type="button" className="msb-panel__link" onClick={() => services.xrayHighlight?.({ table, field })}>
            Show on form
          </button>
        )}
        <CopyButton text={field} label="Copy name" />
        {onAskAi && (
          <button type="button" className="msb-panel__link" onClick={() => onAskAi(`X-ray: ${table}.${field}`, askPrompt(data))}>
            Ask AI to explain
          </button>
        )}
      </div>
    </div>
  );
}

// --- Lists of rows ------------------------------------------------------------------------------

function useFocusRow(key) {
  const ref = useRef(null);
  useEffect(() => {
    if (key && ref.current) ref.current.scrollIntoView({ block: 'nearest' });
  }, [key]);
  return ref;
}

function FieldList({ table, rows, needle, focus, services, onAskAi, emptyText }) {
  const [open, setOpen] = useState(() => (focus ? { [focus]: true } : {}));
  const focusRef = useFocusRow(focus);
  const shown = needle ? rows.filter((r) => matches(needle, r.name, r.label, r.type)) : rows;
  if (!shown.length) return <div className="msb-panel__empty">{emptyText || 'No fields match.'}</div>;
  return (
    <div className="msb-xray__rows">
      {shown.map((row) => (
        <div key={row.name} className={`msb-xray__row${open[row.name] ? ' msb-xray__row--open' : ''}`} ref={row.name === focus ? focusRef : undefined}>
          <button type="button" className="msb-xray__head" aria-expanded={Boolean(open[row.name])} onClick={() => setOpen((prev) => ({ ...prev, [row.name]: !prev[row.name] }))}>
            <span className="msb-xray__chev" aria-hidden="true">
              <Icon name="chevron" size={12} />
            </span>
            <span className="msb-xray__name">{row.name}</span>
            {row.label && <span className="msb-xray__label">{row.label}</span>}
            {row.type && <span className="msb-xray__type">{row.type}</span>}
            <span className="msb-xray__end">
              <Flags live={row.live} />
              <Counts counts={row.counts} />
            </span>
          </button>
          {open[row.name] && <FieldDetail table={table} field={row.name} services={services} onAskAi={onAskAi} />}
        </div>
      ))}
    </div>
  );
}

function Notes({ notes = [], capped = [] }) {
  if (!notes.length && !capped.length) return null;
  return (
    <div className="msb-xray__notes">
      {capped.length > 0 && <div className="msb-panel__hint">Capped: {capped.join(', ')}.</div>}
      {notes.map((note) => (
        <div key={note} className="msb-panel__hint">
          {note}
        </div>
      ))}
    </div>
  );
}

function FormSection({ form, needle, focus, services, onAskAi }) {
  const [all, setAll] = useState(false);
  const rows = all ? [...form.fields, ...form.otherColumns] : form.fields;
  const focusOnForm = focus && (form.fields.some((f) => f.name === focus) || form.otherColumns.some((f) => f.name === focus)) ? focus : '';
  useEffect(() => {
    if (focusOnForm && !form.fields.some((f) => f.name === focusOnForm)) setAll(true);
  }, [focusOnForm, form.fields]);
  return (
    <div className="msb-xray__block">
      <div className="msb-xray__summary">
        <Icon name="form" size={14} />
        <span>
          Form <code>{form.table}</code>
          {form.tables.length > 1 && <span className="msb-panel__hint"> extends {form.tables.slice(1).join(' > ')}</span>}
        </span>
        <span className="msb-xray__spacer" />
        <label className="msb-xray__check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> all {form.fields.length + form.otherColumns.length} columns
        </label>
      </div>
      <FieldList key={all ? 'all' : 'form'} table={form.table} rows={rows} needle={needle} focus={focusOnForm} services={services} onAskAi={onAskAi} emptyText="No fields on this form match." />
      <Notes notes={form.notes} capped={form.capped} />
    </div>
  );
}

function WorkspaceSection({ workspace, needle, focus, services, onAskAi }) {
  return (
    <div className="msb-xray__block">
      <div className="msb-xray__summary">
        <Icon name="monitor" size={14} />
        <span>
          Workspace {workspace.kind}
          {workspace.table && (
            <>
              {' '}
              <code>{workspace.table}</code>
            </>
          )}
        </span>
      </div>
      <div className="msb-panel__hint msb-xray__pad">Workspace forms are built from closed components, so X-ray cannot mark them up or read their live state. Below is the logic for every column of the table.</div>
      {workspace.table ? (
        <FieldList table={workspace.table} rows={workspace.fields} needle={needle} focus={focus} services={services} onAskAi={onAskAi} emptyText="No columns match." />
      ) : (
        <div className="msb-panel__empty">Open a record to see its table.</div>
      )}
      <Notes notes={workspace.notes} capped={workspace.capped} />
    </div>
  );
}

function CatalogSection({ catalog, needle, focus, services }) {
  const [open, setOpen] = useState(() => (focus ? { [focus]: true } : {}));
  const focusRef = useFocusRow(focus);
  const rows = needle ? catalog.variables.filter((v) => matches(needle, v.name, v.label, v.typeName)) : catalog.variables;
  return (
    <div className="msb-xray__block">
      <div className="msb-xray__summary">
        <Icon name="layers" size={14} />
        <span>
          Catalog item{' '}
          {catalog.itemId ? (
            <RecordLink table="sc_cat_item" sysId={catalog.itemId}>
              {catalog.itemName || catalog.itemId}
            </RecordLink>
          ) : (
            <span className="msb-panel__hint">(item not identified)</span>
          )}
        </span>
        <span className="msb-xray__spacer" />
        <span className="msb-panel__hint">{catalog.variables.length} variables</span>
      </div>
      {!rows.length && <div className="msb-panel__empty">No variables match.</div>}
      <div className="msb-xray__rows">
        {rows.map((v) => {
          const entry = v.entry || { clientScripts: [], uiPolicies: [] };
          const counts = { clientScripts: entry.clientScripts.length, uiPolicies: new Set(entry.uiPolicies.map((r) => r.policy.sysId)).size };
          return (
            <div key={v.sysId} className={`msb-xray__row${open[v.name] ? ' msb-xray__row--open' : ''}`} ref={v.name === focus ? focusRef : undefined}>
              <button type="button" className="msb-xray__head" aria-expanded={Boolean(open[v.name])} onClick={() => setOpen((prev) => ({ ...prev, [v.name]: !prev[v.name] }))}>
                <span className="msb-xray__chev" aria-hidden="true">
                  <Icon name="chevron" size={12} />
                </span>
                <span className="msb-xray__name">{v.name}</span>
                {v.label && <span className="msb-xray__label">{v.label}</span>}
                {v.typeName && <span className="msb-xray__type">{v.typeName}</span>}
                <span className="msb-xray__end">
                  <Flags mandatory={v.mandatory} readOnly={v.readOnly} />
                  <Counts counts={counts} />
                </span>
              </button>
              {open[v.name] && (
                <div className="msb-xray__detail">
                  <dl className="msb-xray__facts">
                    <dt>Variable</dt>
                    <dd>
                      <RecordLink table="item_option_new" sysId={v.sysId}>
                        open
                      </RecordLink>
                      {v.variableSet && <span className="msb-panel__hint"> · from a variable set</span>}
                    </dd>
                    {v.reference && (
                      <>
                        <dt>References</dt>
                        <dd>{v.reference}</dd>
                      </>
                    )}
                    {v.defaultValue && (
                      <>
                        <dt>Default</dt>
                        <dd>
                          <code>{v.defaultValue}</code>
                        </dd>
                      </>
                    )}
                  </dl>
                  {entry.clientScripts.length > 0 && (
                    <Section title={`Catalog client scripts (${entry.clientScripts.length})`}>
                      <ul className="msb-xray__items">
                        {entry.clientScripts.map((row) => (
                          <ClientScriptItem key={row.script.sysId} script={row.script} reasons={row.reasons} onChangeOf={row.reasons.includes('onChange') ? v.name : 'another variable'} />
                        ))}
                      </ul>
                    </Section>
                  )}
                  {entry.uiPolicies.length > 0 && (
                    <Section title={`Catalog UI policies (${entry.uiPolicies.length})`}>
                      <ul className="msb-xray__items">
                        {entry.uiPolicies.map((row) => (
                          <PolicyItem key={`${row.policy.sysId}-${row.role}`} {...row} conditionText={readableCatalogCondition(row.policy.conditions, catalog.variables)} />
                        ))}
                      </ul>
                    </Section>
                  )}
                  {!entry.clientScripts.length && !entry.uiPolicies.length && <div className="msb-panel__hint">No catalog client scripts or UI policies touch this variable.</div>}
                  <div className="msb-xray__actions">
                    <button type="button" className="msb-panel__link" onClick={() => services.xrayHighlight?.({ io: v.sysId })}>
                      Show on form
                    </button>
                    <CopyButton text={v.name} label="Copy name" />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Notes notes={catalog.notes} />
    </div>
  );
}

function ListSection({ list, needle, services }) {
  const columns = needle ? list.columns.filter((c) => matches(needle, c.name, c.label, c.type)) : list.columns;
  const ids = list.rowIds;
  return (
    <div className="msb-xray__block">
      <div className="msb-xray__summary">
        <Icon name="table" size={14} />
        <span>
          List <code>{list.table || 'unknown table'}</code>
        </span>
        <span className="msb-xray__spacer" />
        <span className="msb-panel__hint">
          {ids.length} rows on screen{list.hiddenRows ? `, ${list.hiddenRows} hidden` : ''}
        </span>
      </div>
      <pre className="msb-panel__snippet msb-xray__query">{list.explanation}</pre>
      <div className="msb-xray__actions">
        {list.query && <CopyButton text={list.query} label="Copy encoded query" />}
        {ids.length > 0 && <CopyButton text={ids.join(',')} label={`Copy ${ids.length} sys_ids`} />}
        {ids.length > 0 && <CopyButton text={`sys_idIN${ids.join(',')}`} label="Copy as sys_idIN query" />}
      </div>
      {columns.length > 0 ? (
        <table className="msb-xray__table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Label</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.name}>
                <td>
                  <button type="button" className="msb-panel__link msb-xray__mono" title="Show the column on the list" onClick={() => services.xrayHighlight?.({ column: c.name })}>
                    {c.name}
                  </button>
                </td>
                <td>{c.label}</td>
                <td>{c.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="msb-panel__empty">No list columns found on the page.</div>
      )}
    </div>
  );
}

function PortalSection({ portal, needle, focus, services }) {
  const focusRef = useFocusRow(focus);
  const widgets = needle ? portal.widgets.filter((w) => matches(needle, w.name, w.id, w.widgetId)) : portal.widgets;
  return (
    <div className="msb-xray__block">
      <div className="msb-xray__summary">
        <Icon name="monitor" size={14} />
        <span>
          Portal{' '}
          {portal.portal ? (
            <RecordLink table="sp_portal" sysId={portal.portal.sysId}>
              {portal.portal.title || portal.suffix}
            </RecordLink>
          ) : (
            <code>{portal.suffix}</code>
          )}{' '}
          · page{' '}
          {portal.page ? (
            <RecordLink table="sp_page" sysId={portal.page.sysId}>
              {portal.pageId || portal.page.id}
            </RecordLink>
          ) : (
            <code>{portal.pageId || 'home'}</code>
          )}
        </span>
        <span className="msb-xray__spacer" />
        {portal.page?.id && (
          <PathLink href={`/sp_config?id=page_edit&p=${encodeURIComponent(portal.page.id)}`} title="Open the page in the Page Editor">
            Page editor
          </PathLink>
        )}
      </div>
      <div className="msb-panel__hint msb-xray__pad">Turn on "Show on page" and hover a widget to outline it.</div>
      {!widgets.length && <div className="msb-panel__empty">{portal.widgets.length ? 'No widgets match.' : 'No widgets were found on this page.'}</div>}
      <div className="msb-xray__rows">
        {widgets.map((w) => (
          <div key={w.widgetId} className={`msb-xray__row${w.widgetId === focus ? ' msb-xray__row--open' : ''}`} ref={w.widgetId === focus ? focusRef : undefined}>
            <div className="msb-xray__head msb-xray__head--static">
              <span className="msb-xray__name">{w.name || `${w.widgetId.slice(0, 8)}...`}</span>
              {w.id && <span className="msb-xray__label msb-xray__mono">{w.id}</span>}
              <span className="msb-xray__end">
                {w.count > 1 && <span className="msb-panel__hint">{w.count} on page</span>}
              </span>
            </div>
            <div className="msb-xray__actions msb-xray__pad">
              <RecordLink table="sp_widget" sysId={w.widgetId}>
                Widget
              </RecordLink>
              <PathLink href={`/sp_config?id=widget_editor&sys_id=${w.widgetId}`} title="Open in the Widget Editor">
                Editor
              </PathLink>
              {w.instances.slice(0, 4).map((inst, i) => (
                <RecordLink key={inst.sysId} table={inst.table} sysId={inst.sysId}>
                  {inst.title ? `Instance: ${inst.title}` : `Instance ${i + 1}`}
                </RecordLink>
              ))}
              <button type="button" className="msb-panel__link" onClick={() => services.xrayHighlight?.({ widget: w.widgetId })}>
                Show
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Panel ----------------------------------------------------------------------------------------

export default function XrayPanel({ params, services, onClose, onAskAi }) {
  const focus = String(params?.args || '').trim();
  const focusWidget = focus.startsWith('widget:') ? focus.slice(7) : '';
  const focusVar = focus.startsWith('var:') ? focus.slice(4) : '';
  const focusField = focus && !focus.includes(':') ? focus : '';

  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [on, setOn] = useState(() => Boolean(services.xrayStatus?.().on));
  const [filter, setFilter] = useState('');
  const runRef = useRef(0);

  async function load(refresh = false) {
    if (!services.xrayPageReport) {
      setError('X-ray is not available on this page.');
      return;
    }
    const id = ++runRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await services.xrayPageReport({ refresh });
      if (id === runRef.current) setReport(next);
    } catch (err) {
      if (id === runRef.current) setError(err.message || String(err));
    } finally {
      if (id === runRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    load(false);
    // Load once for the page the panel opened on; Refresh re-reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!services.xraySubscribe) return undefined;
    const unsubscribe = services.xraySubscribe((s) => setOn(Boolean(s.on)));
    return () => {
      unsubscribe();
    };
  }, [services]);

  const needle = filter.trim().toLowerCase();
  const hasRows = Boolean(report && (report.form || report.workspace?.table || report.catalog || report.list || report.portal));
  const empty = report && !report.form && !report.list && !report.catalog && !report.portal && !report.workspace;
  // A plain name from "/xray <name>" may be a catalog variable rather than a form field.
  const varFocus = useMemo(() => focusVar || (focusField && report?.catalog?.variables.some((v) => v.name === focusField) ? focusField : ''), [focusVar, focusField, report]);

  return (
    <div className="msb-panel msb-xray">
      <div className="msb-panel__header">
        <strong>Page X-ray</strong>
        <button onClick={onClose} aria-label="Close">
          {'✕'}
        </button>
      </div>

      <div className="msb-xray__bar">
        <button
          type="button"
          className={`msb-xray__toggle${on ? ' msb-xray__toggle--on' : ''}`}
          aria-pressed={on}
          onClick={() => {
            const next = services.xrayToggle?.(!on);
            if (next) setOn(Boolean(next.on));
          }}
        >
          <Icon name="xray" size={14} />
          {on ? 'Showing on page' : 'Show on page'}
        </button>
        <span className="msb-panel__hint">{report?.hotkey || 'Alt+Shift+X'}</span>
        <span className="msb-xray__spacer" />
        <button type="button" className="msb-panel__secondary" onClick={() => load(true)} disabled={busy}>
          {busy ? 'Reading...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="msb-panel__error">{error}</div>}
      {busy && !report && <div className="msb-panel__empty">Reading the page and its configuration...</div>}
      {empty && <div className="msb-panel__empty">Nothing to X-ray here. Open a form, list, catalog item, portal page or workspace record, then press Refresh.</div>}

      {hasRows && (
        <div className="msb-panel__form msb-xray__filter">
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, label or type" aria-label="Filter" />
        </div>
      )}

      {report?.form && <FormSection form={report.form} needle={needle} focus={varFocus ? '' : focusField} services={services} onAskAi={onAskAi} />}
      {report?.catalog && <CatalogSection catalog={report.catalog} needle={needle} focus={varFocus} services={services} />}
      {report?.list && <ListSection list={report.list} needle={needle} services={services} />}
      {report?.portal && <PortalSection portal={report.portal} needle={needle} focus={focusWidget} services={services} />}
      {report?.workspace && <WorkspaceSection workspace={report.workspace} needle={needle} focus={focusField} services={services} onAskAi={onAskAi} />}
    </div>
  );
}
