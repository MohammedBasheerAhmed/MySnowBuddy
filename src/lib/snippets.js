// Tab-triggered snippets for the script editor. "$0" marks where the caret lands.

export const SNIPPETS = {
  gr: "var gr = new GlideRecord('$0');\ngr.addQuery('');\ngr.query();\nwhile (gr.next()) {\n  \n}",
  grget: "var gr = new GlideRecord('$0');\nif (gr.get('')) {\n  \n}",
  gra: "var ga = new GlideAggregate('$0');\nga.addAggregate('COUNT');\nga.query();\nif (ga.next()) {\n  var count = ga.getAggregate('COUNT');\n}",
  gdt: 'var gdt = new GlideDateTime();$0',
  info: "gs.info('$0');",
  err: "gs.error('$0');",
  try: "try {\n  $0\n} catch (e) {\n  gs.error(e.message);\n}",
  fn: 'function $0() {\n  \n}',
  ajax: "var ga = new GlideAjax('$0');\nga.addParam('sysparm_name', '');\nga.getXMLAnswer(function(answer) {\n  \n});",
};

/**
 * Snippet for the word just before the caret, if any.
 * @returns {{start: number, end: number, text: string, caret: number} | null}
 */
export function expandSnippet(source, caret) {
  const lineStart = source.lastIndexOf('\n', caret - 1) + 1;
  const before = source.slice(lineStart, caret);
  const word = /[A-Za-z]+$/.exec(before);
  if (!word || !Object.prototype.hasOwnProperty.call(SNIPPETS, word[0])) return null;
  if (/[\w$.]/.test(before[before.length - word[0].length - 1] || '')) return null;

  const indent = /^[ \t]*/.exec(before)[0];
  const body = SNIPPETS[word[0]].split('\n').join(`\n${indent}`);
  const marker = body.indexOf('$0');
  const text = body.replace('$0', '');
  return {
    start: caret - word[0].length,
    end: caret,
    text,
    caret: caret - word[0].length + (marker === -1 ? text.length : marker),
  };
}
