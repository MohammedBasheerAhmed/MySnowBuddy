// Turn query results into text formats people paste into tickets, wikis and spreadsheets.

/** Reduce a Table API cell (string, or {value, display_value}) to display text. */
export function flattenValue(cell) {
  if (cell == null) return '';
  if (typeof cell === 'object') {
    if ('display_value' in cell && cell.display_value !== '') return String(cell.display_value);
    if ('value' in cell) return String(cell.value ?? '');
    return JSON.stringify(cell);
  }
  return String(cell);
}

/** Raw value (sys_id for references) of a cell. */
export function rawValue(cell) {
  if (cell == null) return '';
  if (typeof cell === 'object' && 'value' in cell) return String(cell.value ?? '');
  return String(cell);
}

function csvCell(text) {
  let value = text;
  // Stop spreadsheet apps from running cell contents as a formula.
  if (/^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value)) value = `'${value}`;
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows, columns) {
  const lines = [columns.map(csvCell).join(',')];
  rows.forEach((row) => lines.push(columns.map((c) => csvCell(flattenValue(row[c]))).join(',')));
  return lines.join('\r\n');
}

function mdCell(text) {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function toMarkdownTable(rows, columns) {
  if (!columns.length) return '';
  const header = `| ${columns.map(mdCell).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((c) => mdCell(flattenValue(row[c]))).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

export function toJson(rows, columns) {
  const out = rows.map((row) => {
    const obj = {};
    columns.forEach((c) => {
      obj[c] = flattenValue(row[c]);
    });
    return obj;
  });
  return JSON.stringify(out, null, 2);
}

/** One sys_id per line, ready to paste into an IN query. */
export function sysIdList(rows) {
  return rows.map((r) => rawValue(r.sys_id)).filter(Boolean);
}
