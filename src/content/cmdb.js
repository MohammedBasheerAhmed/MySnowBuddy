// CMDB helpers for the /dedupe assistant. Fetches a bounded batch of CIs from
// the current instance under the user's own permissions.
import { queryTable } from './tableApi.js';

const CI_FIELDS = [
  'sys_id',
  'name',
  'sys_class_name',
  'serial_number',
  'ip_address',
  'fqdn',
  'asset_tag',
  'manufacturer',
  'model_id',
  'install_status',
];

export async function fetchCiBatch({ table = 'cmdb_ci', query = 'install_status!=7' } = {}) {
  const results = await queryTable(table, query, CI_FIELDS);
  return results;
}

// Trim each CI down to the fields that actually help duplicate detection, to
// keep the prompt small and avoid sending unnecessary data to the provider.
export function summarizeCisForPrompt(cis) {
  return cis.map((ci) => ({
    sys_id: ci.sys_id,
    name: ci.name,
    class: ci.sys_class_name,
    serial: ci.serial_number,
    ip: ci.ip_address,
    fqdn: ci.fqdn,
    asset_tag: ci.asset_tag,
  }));
}
