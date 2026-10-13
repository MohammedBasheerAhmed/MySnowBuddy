// Work out which classic page a ServiceNow URL is really showing.
//
// Classic UI wraps pages as nav_to.do?uri=<page>, and the Next Experience
// shell wraps them as /now/nav/ui/classic/params/target/<encoded page>.

export function resolveTarget(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  let target = url.searchParams.get('uri');
  if (!target) {
    const match = url.pathname.match(/\/params\/target\/(.+)$/);
    if (match) {
      try {
        target = decodeURIComponent(match[1]);
      } catch {
        return url;
      }
    }
  }
  if (!target) return url;

  try {
    return new URL(`/${target.replace(/^\/+/, '')}`, url.origin);
  } catch {
    return url;
  }
}

/** { table, sysId, isList } for the page behind `href`, or nulls when it is not a table page. */
export function parseTablePage(href) {
  const url = resolveTarget(href);
  const empty = { table: null, sysId: null, isList: false };
  if (!url) return empty;

  const match = url.pathname.match(/\/([a-z0-9_]+)\.do$/i);
  if (!match) return empty;

  const isList = /_list$/i.test(match[1]);
  const table = isList ? match[1].replace(/_list$/i, '') : match[1];
  const sysId = url.searchParams.get('sys_id');
  return { table, sysId: sysId && sysId !== '-1' ? sysId : null, isList };
}

/** { table, query } for a list page, or null. */
export function extractListFromUrl(href) {
  const url = resolveTarget(href);
  if (!url) return null;
  const page = parseTablePage(href);
  if (!page.isList) return null;
  return { table: page.table, query: url.searchParams.get('sysparm_query') || '' };
}
