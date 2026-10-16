// Skill packs: knowledge + the tools and verifier that go with it, loaded by
// the page the user is on.
import { CLIENT_SCRIPT_SKILL } from './clientScript.js';
import { SERVER_SCRIPT_SKILL } from './serverScript.js';

export const SKILLS = [CLIENT_SCRIPT_SKILL, SERVER_SCRIPT_SKILL];

export const getSkill = (id) => SKILLS.find((s) => s.id === id) || null;

/**
 * Pick skills for a page context ({ table, isList, ... }).
 * `primary` is loaded in full; `secondary` is a one-line digest so the model
 * knows the other side exists. When the page does not decide it (a plain data
 * table such as incident), the primary is the client skill if the user is on a
 * form and the server skill otherwise.
 */
export function selectSkills(context = {}) {
  const table = context.table || '';
  const byTable = SKILLS.find((s) => s.tables.includes(table));
  if (byTable) {
    return { primary: byTable, secondary: SKILLS.find((s) => s !== byTable), reason: `the open record is a ${table}` };
  }
  if (table && !context.isList) {
    return { primary: CLIENT_SCRIPT_SKILL, secondary: SERVER_SCRIPT_SKILL, reason: `a ${table} form is open` };
  }
  return { primary: SERVER_SCRIPT_SKILL, secondary: CLIENT_SCRIPT_SKILL, reason: table ? `a ${table} list is open` : 'no record is open' };
}

/** Markdown for MCP resources and the get_skill_guide tool. */
export function skillResources() {
  return SKILLS.map((s) => ({ id: s.id, title: `${s.title} skill`, description: s.summary, text: s.guide }));
}
