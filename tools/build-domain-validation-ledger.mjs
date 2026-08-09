import fs from 'node:fs/promises';
import path from 'node:path';
import { inferSundaySelectedValue } from '../core/sunday-selection.js';
import { validateDomainVerificationLedger } from '../core/domain-validation.js';

const root = path.resolve(import.meta.dirname, '..');
const sourceMap = JSON.parse(await fs.readFile(path.join(root, 'data/source-execution-map.json'), 'utf8'));
const candidates = JSON.parse(await fs.readFile(path.join(root, 'data/source-candidates.json'), 'utf8'));
const outputPath = path.join(root, 'data/domain-validation-ledger.json');
let previous = { entries: {} };
try {
  previous = JSON.parse(await fs.readFile(outputPath, 'utf8'));
} catch {
  // 首次生成没有旧档案属于正常情况。
}

const entries = {};
for (const [sourceName, mapping] of Object.entries(sourceMap.domains ?? {})) {
  const related = Object.values(candidates).filter((item) => item.gameDomainName === sourceName);
  const openDays = unique(related.flatMap((item) => (item.daysOfWeek ?? []).map(toWeekdayNumber)))
    .filter((day) => day !== undefined).sort((left, right) => left - right);
  if (openDays.length === 0) throw new Error(`来源“${sourceName}”无法从候选数据推导开放日`);
  const old = previous.entries?.[sourceName] ?? {};
  entries[sourceName] = {
    domainName: mapping.domainName,
    openDays,
    sundaySelectedValue: inferSundaySelectedValue(openDays),
    testedMaterials: unique(related.map((item) => item.name)).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    status: old.status ?? inferInitialStatus(mapping.verification),
    bettergiVersion: old.bettergiVersion ?? (mapping.verification?.includes('已') ? '0.44.4' : null),
    verifiedAt: old.verifiedAt ?? null,
    result: old.result ?? mapping.verification ?? '待验证',
    failureReason: old.failureReason ?? null,
    notes: old.notes ?? (mapping.verification?.includes('已实机执行') ? '历史实测日期未单独记录，后续回归时补齐日期并改为 verified' : null),
  };
}

const ledger = {
  schemaVersion: 1,
  generatedFrom: 'data/source-execution-map.json + data/source-candidates.json',
  entries,
};
const summary = validateDomainVerificationLedger(sourceMap, ledger);
await fs.writeFile(outputPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
console.log(`已生成秘境映射验证档案：${summary.total} 条；${JSON.stringify(summary.statuses)}`);

function inferInitialStatus(verification = '') {
  if (verification.includes('已实机执行')) return 'historical-pass';
  if (verification.includes('已按')) return 'catalog-checked';
  return 'pending';
}

function toWeekdayNumber(value) {
  return { 周日: 0, 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6 }[value];
}

function unique(values) {
  return [...new Set(values)];
}
