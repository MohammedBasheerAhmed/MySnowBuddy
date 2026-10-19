// Record numbers as people type them: INC0010001, CHG0030002, STRY0012345, KB0000015. Two to eight letters then five to
// ten digits. A 32-character sys_id never fits, and a table name has no digits run that long.

const NUMBER_RE = /^([A-Za-z]{2,8})(\d{5,10})$/;

/** The record number in upper case, or '' when the text is not shaped like one. */
export function parseRecordNumber(text) {
  const match = NUMBER_RE.exec(String(text ?? '').trim());
  return match ? `${match[1].toUpperCase()}${match[2]}` : '';
}

/** Tables to look in: task and everything extending it, plus knowledge articles for KB numbers. */
export function tablesForNumber(number) {
  return /^KB/i.test(number) ? ['kb_knowledge', 'task'] : ['task', 'kb_knowledge'];
}
