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
