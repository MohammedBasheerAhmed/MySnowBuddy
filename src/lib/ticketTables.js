// Which tables hold tickets: the records people work, wait on and get email about. The palette suggests the flow,
// approval and email tools on them, and the on-page toolbar offers a "Why?" menu.
//
// The page context knows only the table NAME, not its parents, so this is a list of the common ones. A custom table
// that extends task is not recognised; the same tools are still in the palette and the launcher.

export const TICKET_TABLES = [
  'task',
  'incident',
  'incident_task',
  'problem',
  'problem_task',
  'change_request',
  'change_task',
  'sc_request',
  'sc_req_item',
  'sc_task',
  'sn_customerservice_case',
  'sn_customerservice_task',
  'sn_hr_core_case',
  'sn_hr_core_task',
  'sn_si_incident',
  'sn_si_task',
];

const TICKETS = new Set(TICKET_TABLES);

/** True for a table that is known to hold tickets. */
export function isTicketTable(table) {
  return TICKETS.has(String(table || '').trim().toLowerCase());
}
