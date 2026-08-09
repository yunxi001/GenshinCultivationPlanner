import { inferSundaySelectedValue } from './sunday-selection.js';

const VALID_STATUSES = new Set(['verified', 'historical-pass', 'catalog-checked', 'pending', 'failed']);

/** 验证每条秘境映射都有可追踪的验证档案，且开放日与周日序号一致。 */
export function validateDomainVerificationLedger(sourceExecutionMap, ledger) {
  if (ledger?.schemaVersion !== 1 || !ledger.entries || typeof ledger.entries !== 'object') {
    throw new Error('秘境映射验证档案格式无效');
  }
  const mappings = sourceExecutionMap?.domains ?? {};
  const sourceNames = Object.keys(mappings);
  const ledgerNames = Object.keys(ledger.entries);
  const missing = sourceNames.filter((name) => !ledger.entries[name]);
  const extra = ledgerNames.filter((name) => !mappings[name]);
  if (missing.length > 0) throw new Error(`秘境验证档案缺少 ${missing.length} 条映射：${missing.join('、')}`);
  if (extra.length > 0) throw new Error(`秘境验证档案包含已不存在的映射：${extra.join('、')}`);

  for (const [sourceName, mapping] of Object.entries(mappings)) {
    const record = ledger.entries[sourceName];
    if (record.domainName !== mapping.domainName) {
      throw new Error(`来源“${sourceName}”的验证档案秘境名称不一致`);
    }
    if (!VALID_STATUSES.has(record.status)) throw new Error(`来源“${sourceName}”的验证状态无效：${record.status}`);
    if (!Array.isArray(record.openDays) || record.openDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error(`来源“${sourceName}”的开放日无效`);
    }
    const expectedSundayValue = inferSundaySelectedValue(record.openDays);
    if (String(record.sundaySelectedValue) !== String(expectedSundayValue)) {
      throw new Error(`来源“${sourceName}”的周日奖励序号应为 ${expectedSundayValue}`);
    }
    if (record.status === 'verified') {
      if (!/^\d+\.\d+\.\d+$/.test(record.bettergiVersion ?? '')) {
        throw new Error(`来源“${sourceName}”已标记验证通过，但未填写完整 BetterGI 版本`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.verifiedAt ?? '')) {
        throw new Error(`来源“${sourceName}”已标记验证通过，但未填写验证日期`);
      }
    }
  }
  return { total: sourceNames.length, statuses: countStatuses(Object.values(ledger.entries)) };
}

function countStatuses(records) {
  const result = {};
  for (const record of records) result[record.status] = (result[record.status] ?? 0) + 1;
  return result;
}
