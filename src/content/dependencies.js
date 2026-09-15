// Script Include dependency graph: who calls this, and what does it call?
//
// Answering "is it safe to change this Script Include?" normally means
// manually grepping the instance. This builds both directions of the call
// graph and renders it as Mermaid so it can be read at a glance.

import { queryTable, queryInChunks } from './tableApi.js';
import { searchCode } from './codeSearch.js';

/** JavaScript identifiers that look like class references but are not ours. */
const BUILT_IN_GLOBALS = new Set([
  'GlideRecord', 'GlideRecordSecure', 'GlideAggregate', 'GlideDateTime', 'GlideDate',
  'GlideDuration', 'GlideElement', 'GlideSession', 'GlideSystem', 'GlideUser',
  'GlideAjax', 'GlideModal', 'GlideDialogWindow', 'GlideURL', 'GlideForm', 'GlideList2',
  'GlideFilter', 'GlideEncrypter', 'GlideProperties', 'GlideScopedEvaluator',
  'GlideTableHierarchy', 'GlideQueryCondition', 'GlideSysAttachment', 'GlideEmailOutbound',
  'GlideTemplate', 'GlideScriptedProcessor', 'GlideSecureRandomUtil', 'GlideDigest',
  'GlideStringUtil', 'GlideXMLUtil', 'GlideChecksum', 'GlideExcelParser',
  'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'RegExp',
  'Error', 'TypeError', 'Promise', 'Map', 'Set', 'WeakMap', 'Function', 'Class',
  'Packages', 'GlideTransaction', 'RESTMessageV2', 'SOAPMessageV2', 'XMLDocument2',
]);

/** Pull candidate Script Include names referenced by a script body. */
export function extractReferencedNames(script) {
  if (!script) return [];
  const names = new Set();

  // `new Something(`
  const constructors = /\bnew\s+([A-Z][A-Za-z0-9_]{1,60})\s*\(/g;
  let match = constructors.exec(script);
  while (match) {
    names.add(match[1]);
    match = constructors.exec(script);
  }

  // `Something.staticMethod(` - static Script Include usage.
  const statics = /\b([A-Z][A-Za-z0-9_]{1,60})\s*\.\s*[a-z][A-Za-z0-9_]*\s*\(/g;
  match = statics.exec(script);
  while (match) {
    names.add(match[1]);
    match = statics.exec(script);
  }

  // `new global.Something(` / `new x_scope.Something(`
  const scoped = /\bnew\s+(?:global|x_[a-z0-9_]+)\s*\.\s*([A-Z][A-Za-z0-9_]{1,60})\s*\(/g;
  match = scoped.exec(script);
  while (match) {
    names.add(match[1]);
    match = scoped.exec(script);
  }

  return [...names].filter((name) => !BUILT_IN_GLOBALS.has(name));
}

/**
 * Build the dependency graph for one Script Include.
 *
 * @param {string} name Script Include name.
 * @param {{depth?: number, maxCallers?: number}} options
 */
export async function buildDependencyGraph(name, options = {}) {
  const { depth = 1, maxCallers = 40 } = options;
  const rootName = (name || '').trim();
  if (!rootName) throw new Error('Provide a Script Include name, e.g. /deps IncidentUtils');

  const rootRows = await queryTable(
    'sys_script_include',
    `name=${rootName}`,
    ['sys_id', 'name', 'api_name', 'script', 'active', 'access'],
    { limit: 1 }
  );
  if (!rootRows.length) {
    throw new Error(`No Script Include named "${rootName}" was found on this instance.`);
  }
  const root = rootRows[0];

  // --- Callees: names referenced by the root, confirmed against the table ---
  const referenced = extractReferencedNames(root.script);
  const confirmedCallees = referenced.length
    ? await queryInChunks(
        'sys_script_include',
        'name',
        referenced,
        ['sys_id', 'name', 'api_name', 'active'],
        { chunkSize: 40, limit: 200 }
      )
    : [];

  // --- Callers: anything on the instance mentioning the root name ---
  const callerSearch = await searchCode(rootName, { activeOnly: true, wholeWord: true, limitPerTable: 60 });
  const callers = callerSearch.results
    .filter((r) => !(r.table === 'sys_script_include' && r.sysId === root.sys_id))
    .slice(0, maxCallers)
    .map((r) => ({
      table: r.table,
      label: r.label,
      sysId: r.sysId,
      name: r.name,
      field: r.field,
      matchCount: r.matches.length,
    }));

  // --- Optional second level: what the direct callees call ---
  const secondLevel = [];
  if (depth > 1 && confirmedCallees.length) {
    const detailed = await queryInChunks(
      'sys_script_include',
      'name',
      confirmedCallees.map((c) => c.name),
      ['sys_id', 'name', 'script'],
      { chunkSize: 20, limit: 100 }
    );
    detailed.forEach((row) => {
      extractReferencedNames(row.script).forEach((childName) => {
        if (childName === row.name) return;
        secondLevel.push({ from: row.name, to: childName });
      });
    });
  }

  return {
    root: {
      name: root.name,
      sysId: root.sys_id,
      apiName: root.api_name,
      active: root.active,
      access: root.access,
      lineCount: (root.script || '').split('\n').length,
    },
    callees: confirmedCallees.map((c) => ({
      name: c.name,
      sysId: c.sys_id,
      apiName: c.api_name,
      active: c.active,
    })),
    unresolvedReferences: referenced.filter(
      (r) => !confirmedCallees.some((c) => c.name === r)
    ),
    callers,
    secondLevel,
    searchErrors: callerSearch.errors,
  };
}

/** Mermaid node ids must be alphanumeric; labels keep the original text. */
function nodeId(prefix, value) {
  return `${prefix}_${String(value).replace(/[^A-Za-z0-9]/g, '_').slice(0, 40)}`;
}

/** Render the graph as a Mermaid flowchart, ready to drop in a markdown block. */
export function buildMermaid(graph) {
  const lines = ['graph LR'];
  const rootId = nodeId('root', graph.root.name);
  lines.push(`  ${rootId}["${graph.root.name}"]`);
  lines.push(`  style ${rootId} fill:#0b6ea8,stroke:#08415c,color:#ffffff`);

  const seenEdges = new Set();
  function addEdge(edge) {
    if (seenEdges.has(edge)) return;
    seenEdges.add(edge);
    lines.push(`  ${edge}`);
  }

  graph.callers.slice(0, 25).forEach((caller) => {
    const id = nodeId('c', `${caller.table}_${caller.sysId}`);
    lines.push(`  ${id}["${caller.label}: ${caller.name.replace(/"/g, "'")}"]`);
    addEdge(`${id} --> ${rootId}`);
  });

  graph.callees.slice(0, 25).forEach((callee) => {
    const id = nodeId('d', callee.name);
    lines.push(`  ${id}["${callee.name}"]`);
    addEdge(`${rootId} --> ${id}`);
  });

  graph.secondLevel.slice(0, 40).forEach(({ from, to }) => {
    addEdge(`${nodeId('d', from)} --> ${nodeId('d', to)}`);
  });

  return lines.join('\n');
}

/** Text rendering for the chat transcript (no AI call required). */
export function formatDependencyGraph(graph) {
  const parts = [
    `Script Include: ${graph.root.name}` +
      `${graph.root.apiName ? ` (${graph.root.apiName})` : ''}` +
      ` - ${graph.root.lineCount} lines, active=${graph.root.active}, access=${graph.root.access || 'n/a'}`,
    '',
    `Called by ${graph.callers.length} artifact(s):`,
    graph.callers.length
      ? graph.callers.map((c) => `  - ${c.label}: ${c.name} (${c.field})`).join('\n')
      : '  - Nothing references it. Verify before assuming it is dead code: dynamic ' +
        'lookups and GlideAjax calls by string name will not appear here.',
    '',
    `Calls ${graph.callees.length} other Script Include(s):`,
    graph.callees.length ? graph.callees.map((c) => `  - ${c.name}`).join('\n') : '  - None.',
  ];

  if (graph.unresolvedReferences.length) {
    parts.push(
      '',
      `Unresolved references (not Script Includes, or not readable): ${graph.unresolvedReferences.join(', ')}`
    );
  }

  parts.push('', '```mermaid', buildMermaid(graph), '```');
  return parts.join('\n');
}
