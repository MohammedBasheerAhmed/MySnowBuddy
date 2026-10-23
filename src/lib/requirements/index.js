// What each feature needs from a ServiceNow instance (tables and columns), so the Self-check panel can say which
// tools will work on this instance and which will not, before a developer finds out by hitting an error.
//
// Every feature keeps its own list next to this file. A list is an array of
//   { feature: 'Email tracer', table: 'sys_email', columns: ['subject', 'state'], optional?: true, note?: 'why it is read' }
// `optional` means the feature still works without it (a section is left out). The doctor reads ALL_REQUIREMENTS.
//
// More optional properties, added by the Self-check (a list that does not use them is unaffected):
//   optionalColumns?: ['reason']   columns of a required table that the code tolerates missing
//   fallbackFor?: 'table'          the tool reads this table only when `table` cannot be read, so it is no gap while that one can be
//   alternates?: ['col']           names other releases use for the same fact; the code reads whichever exist, so the Self-check never
//                                  reports them missing (one of a set of alternates is always absent)
//   panel?: 'notify'               the registered panel name that opens the tool (else the Self-check matches `feature`
//                                  against the panel titles in src/sidebar/panelRegistry.js)
// A dotted column ('update_set.name') is checked on its first part only. Use the same `feature` string in every entry of
// one tool: the Self-check shows one row per feature. tests/doctor.test.js checks the shape of every list.

import { REQUIREMENTS as clientTrace } from './clientTrace.js';
import { REQUIREMENTS as notify } from './notify.js';
import { REQUIREMENTS as processView } from './process.js';
import { REQUIREMENTS as properties } from './properties.js';
import { REQUIREMENTS as dataModel } from './datamodel.js';
import { REQUIREMENTS as portal } from './portal.js';
import { REQUIREMENTS as previewProblems } from './previewProblems.js';
import { REQUIREMENTS as goTo } from './goto.js';
import { REQUIREMENTS as existing } from './existing.js';

export const ALL_REQUIREMENTS = [...existing, ...clientTrace, ...notify, ...processView, ...properties, ...dataModel, ...portal, ...previewProblems, ...goTo];
