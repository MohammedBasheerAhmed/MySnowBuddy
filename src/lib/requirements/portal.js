// What the "portal" feature (Portal inspector) needs from the instance, for the Self-check panel (src/lib/requirements/index.js).
// One entry per table: { feature, table, columns: [...], optional?: true, note?: "why" }.
//
// Nothing here was checked against a live schema (no instance was available while it was written): the Self-check panel
// is how these names get confirmed. A missing column is never guessed around: the panel says "Not returned by this
// instance: <columns>" and leaves that part out.

export const REQUIREMENTS = [
  {
    feature: 'Portal inspector',
    table: 'sp_widget',
    columns: ['sys_id', 'name', 'id', 'script', 'client_script', 'template', 'css', 'option_schema', 'data_table', 'link', 'roles', 'public', 'sys_updated_on', 'sys_updated_by'],
    note: 'The widget behind the selected widget: its name and id, and the server script, client controller, HTML and option schema that "What its code touches" reads.',
  },
  {
    feature: 'Portal inspector',
    table: 'sp_instance',
    columns: ['sys_id', 'sp_widget', 'title', 'sys_class_name', 'widget_parameters', 'sys_updated_on'],
    note: 'The widget instance: its title, its class (sp_instance or a child such as sp_instance_carousel) and the options saved on it (widget_parameters, JSON).',
  },
  {
    feature: 'Portal inspector',
    table: 'sp_page',
    columns: ['sys_id', 'id', 'title'],
    optional: true,
    note: 'The page record for the id= in the URL (looked up by id; the answer is checked, so a missing id column is noticed). Without it the page link is left out.',
  },
  {
    feature: 'Portal inspector',
    table: 'sp_portal',
    columns: ['sys_id', 'title', 'url_suffix'],
    optional: true,
    note: 'The portal record for the URL suffix (/sp, /esc). Without it the portal name and link are left out.',
  },
  {
    feature: 'Portal inspector',
    table: 'sys_script_include',
    columns: ['sys_id', 'name'],
    optional: true,
    note: 'Confirms which names in a widget script are really Script Includes, so each one can link to its record.',
  },
];
