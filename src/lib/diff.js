// Minimal line-level diff (LCS-based). Vendored rather than pulling in a
// dependency, per the build spec's "no heavy deps" requirement.

function lcsMatrix(a, b) {
  const m = a.length;
  const n = b.length;
  const table = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

// Returns an array of { type: 'equal'|'added'|'removed', value: string }
export function diffLines(oldText, newText) {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');
  const table = lcsMatrix(a, b);

  const result = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ type: 'equal', value: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      result.push({ type: 'removed', value: a[i] });
      i += 1;
    } else {
      result.push({ type: 'added', value: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    result.push({ type: 'removed', value: a[i] });
    i += 1;
  }
  while (j < b.length) {
    result.push({ type: 'added', value: b[j] });
    j += 1;
  }
  return result;
}

// Compact the diff to only changed lines plus a little surrounding context,
// so large scripts don't produce unusable output (or oversized AI prompts).
export function summarizeDiff(diff, contextLines = 2) {
  const keep = new Set();
  diff.forEach((part, index) => {
    if (part.type !== 'equal') {
      for (let k = index - contextLines; k <= index + contextLines; k += 1) {
        if (k >= 0 && k < diff.length) keep.add(k);
      }
    }
  });

  const lines = [];
  let lastKept = -1;
  Array.from(keep)
    .sort((x, y) => x - y)
    .forEach((index) => {
      if (lastKept !== -1 && index > lastKept + 1) lines.push('...');
      const part = diff[index];
      const prefix = part.type === 'added' ? '+' : part.type === 'removed' ? '-' : ' ';
      lines.push(`${prefix}${part.value}`);
      lastKept = index;
    });

  return lines.join('\n');
}

export function hasChanges(diff) {
  return diff.some((part) => part.type !== 'equal');
}
