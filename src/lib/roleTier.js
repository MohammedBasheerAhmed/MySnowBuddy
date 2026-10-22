// Which tools a user is shown, by ServiceNow role. This is a convenience, not security: ServiceNow's own ACLs
// still decide what any request may read or write. The tiers keep a user from meeting tools that can only
// answer "403" for them.
//
//   user       everyone signed in: copy, explain, count, lint, the query tools
//   developer  can read and change configuration (rules, script includes, dictionary, update sets)
//   admin      the admin role: audit log, logs, instance stats, impersonation, background scripts
//
// Unknown (roles could not be read) shows everything: hiding on a guess would take tools away from admins.

export const TIERS = ['user', 'developer', 'admin'];
export const DEFAULT_DEVELOPER_ROLES = ['delegated_developer', 'personalize_dictionary'];

const rank = (tier) => Math.max(0, TIERS.indexOf(tier));

/** Role names from a settings string ("a, b") or an array, trimmed and lower-cased. */
export function parseRoleList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,\s]+/);
  return [...new Set(list.map((r) => String(r).trim().toLowerCase()).filter(Boolean))];
}

/**
 * The tier of a session. `info` is { roles, admin } as the page reports it; null or no roles at all is unknown (null).
 * `developerRoles`: roles that count as developer without admin.
 */
export function tierFromSession(info, developerRoles = DEFAULT_DEVELOPER_ROLES) {
  if (!info) return null;
  const roles = Array.isArray(info.roles) ? parseRoleList(info.roles) : null;
  if (info.admin === true || roles?.includes('admin')) return 'admin';
  if (!roles) return null;
  const dev = parseRoleList(developerRoles);
  return roles.some((r) => dev.includes(r)) ? 'developer' : 'user';
}

/** The least tier that may see each tool. A tool that is not listed is for everyone. */
const DEVELOPER_TOOLS = [
  // palette commands
  'tools.editor', 'tools.fileSync', 'tools.fileSyncStop', 'record.versions', 'record.versionDiff', 'record.remote',
  'analyze.search', 'analyze.updateset', 'analyze.conflict', 'ai.review', 'ai.atf', 'ai.document',
  'tools.newUpdateSet', 'tools.atf', 'tools.rest', 'tools.testbench', 'tools.verify', 'tools.automate',
  'analyze.xrayToggle', 'savetrace.arm', 'tools.switchUpdateSet',
  // page toolbar and menus
  'versions', 'refs', 'edit', 'dictionary', 'acls', 'xray', 'editHere', 'xml',
];
const ADMIN_TOOLS = [
  'record.history', 'record.updateEntry', 'analyze.logTail', 'analyze.audit', 'analyze.compare', 'ai.logs',
  'tools.background', 'tools.scopeExport', 'tools.impersonate', 'testdata.cleanup',
  'instance.cache', 'instance.stats', 'instance.nodeInfo', 'instance.xmlstats', 'instance.threads',
];

const REQUIRED = new Map([...DEVELOPER_TOOLS.map((id) => [id, 'developer']), ...ADMIN_TOOLS.map((id) => [id, 'admin'])]);

export const requiredTier = (id) => REQUIRED.get(id) || 'user';

/** Whether a user of `tier` (null = unknown) is shown tool `id`. */
export function canSee(tier, id) {
  if (!tier) return true;
  return rank(tier) >= rank(requiredTier(id));
}

/** Keep the items (anything with an `id`) that the tier may see. */
export const visibleTo = (tier, items) => (tier ? items.filter((item) => canSee(tier, item.id)) : items);

/** One sentence for "why are some tools hidden", or '' when nothing is. */
export function tierNote(tier) {
  if (tier === 'user') return 'Tools that read or change configuration and the admin tools are hidden for your roles. Ask an admin for a developer role, or turn "Show tools by role" off in Options.';
  if (tier === 'developer') return 'The admin-only tools (audit log, instance stats, impersonation, background scripts) are hidden for your roles. Turn "Show tools by role" off in Options to see them.';
  return '';
}

// Slash verbs (/br, /bg, ...) by the least tier that can use them. Finders are keyed by their main verb.
const SLASH_DEVELOPER = ['br', 'si', 'cl', 'uia', 'uip', 'uis', 'uipg', 'macro', 'acl', 'fix', 'job', 'ea', 'evt', 'notif', 'sra', 'tm', 'flow', 'widget', 'page', 'dict', 'app', 'us', 'code', 'sync', 'edit', 'new', 'xml', 'su', 'sa'];
const SLASH_ADMIN = ['bg', 'cs', 'stats', 'log', 'props', 'role', 'mail'];
const SLASH_REQUIRED = new Map([...SLASH_DEVELOPER.map((v) => [v, 'developer']), ...SLASH_ADMIN.map((v) => [v, 'admin'])]);

/** The least tier for a slash verb (pass the main verb of a finder, not an alias). */
export const slashTier = (verb) => SLASH_REQUIRED.get(String(verb || '').toLowerCase()) || 'user';

/** Whether a user of `tier` (null = unknown) may use the slash verb. */
export const canUseSlash = (tier, verb) => !tier || rank(tier) >= rank(slashTier(verb));
