import React, { useState } from 'react';
import Icon from './Icon.jsx';

// Splits assistant output into plain text and fenced code blocks. Deliberately
// minimal: no HTML is produced from model output, only text nodes.
function splitBlocks(text) {
  const blocks = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = fence.exec(text)) !== null) {
    if (match.index > last) blocks.push({ type: 'text', value: text.slice(last, match.index) });
    blocks.push({ type: 'code', value: match[1].replace(/\n$/, '') });
    last = fence.lastIndex;
  }
  if (last < text.length) blocks.push({ type: 'text', value: text.slice(last) });
  return blocks;
}

function CodeBlock({ value, onApply }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="msb-sidebar__msg-code">
      <pre>{value}</pre>
      {onApply && (
        <button
          type="button"
          className="msb-sidebar__msg-apply"
          title="Put this code in a script field on the open form (shows a diff first)"
          onClick={() => onApply(value)}
        >
          Apply
        </button>
      )}
      <button
        type="button"
        title={copied ? 'Copied' : 'Copy code'}
        aria-label="Copy code"
        onClick={() => {
          navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Icon name="copy" size={13} />
      </button>
    </div>
  );
}

/**
 * /help output: "Section" lines followed by "  /command   description" lines (columns padded
 * with spaces for a monospace terminal). Laid out as a two-column list so the descriptions line
 * up and wrap under themselves in a proportional font at any sidebar width.
 */
export function HelpBody({ text }) {
  const sections = [];
  let current = null;
  String(text ?? '')
    .split('\n')
    .forEach((line) => {
      if (!line.trim()) {
        current = null;
        return;
      }
      if (!current) {
        current = { title: '', rows: [] };
        sections.push(current);
      }
      if (/^\S/.test(line) && !current.rows.length && !current.title) {
        current.title = line.trim();
        return;
      }
      const m = /^\s+(\S.*?)\s{2,}(\S.*)$/.exec(line);
      current.rows.push(m ? { cmd: m[1], desc: m[2] } : { cmd: line.trim(), desc: '' });
    });
  return (
    <div className="msb-sidebar__msg-body msb-help">
      {sections.map((section, i) => (
        // eslint-disable-next-line react/no-array-index-key -- static text, never reordered.
        <div key={i} className="msb-help__section">
          {section.title && <div className="msb-help__title">{section.title}</div>}
          {section.rows.length > 0 && (
            <dl className="msb-help__list">
              {section.rows.map((row, j) => (
                // eslint-disable-next-line react/no-array-index-key
                <React.Fragment key={j}>
                  <dt className={row.desc ? '' : 'msb-help__wide'}>
                    <code>{row.cmd}</code>
                  </dt>
                  {row.desc && <dd>{row.desc}</dd>}
                </React.Fragment>
              ))}
            </dl>
          )}
        </div>
      ))}
    </div>
  );
}

export default function MessageBody({ text, onApply }) {
  const value = String(text ?? '');
  const blocks = splitBlocks(value);
  return (
    <div className="msb-sidebar__msg-body">
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <CodeBlock key={i} value={block.value} onApply={onApply} />
        ) : (
          <span key={i}>{block.value.replace(/^\n+|\n+$/g, '')}</span>
        )
      )}
    </div>
  );
}
