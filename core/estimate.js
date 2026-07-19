/**
 * 只使用执行后背包差值已确认的历史记录估算自动秘境材料完成时间。
 * 一次运行被视作该秘境在一个开放日内的一批刷取；没有可靠样本绝不输出虚假的天数。
 */
export function buildCompletionEstimate({ plan, history, materials, today }) {
  const shortages = (plan.displayShortages ?? []).filter((item) => item.shortage > 0);
  if (shortages.some((item) => materials[item.materialId]?.executionType !== 'domain'
    || materials[item.materialId]?.status !== 'supported')) {
    return { days: null, reason: '含未自动执行材料，无法估算全部完成时间', details: [] };
  }
  if (shortages.length === 0) return { days: 0, reason: '材料已满足', details: [] };

  const details = [];
  for (const shortage of shortages) {
    const material = materials[shortage.materialId];
    const samples = confirmedSamples(history, material.domainName, material.name);
    if (samples.length === 0) {
      return { days: null, reason: `材料“${material.name}”缺少已确认掉落样本`, details };
    }
    const average = samples.reduce((total, count) => total + count, 0) / samples.length;
    if (average <= 0) {
      return { days: null, reason: `材料“${material.name}”的历史收益为零，无法估算`, details };
    }
    const estimatedRuns = Math.ceil(shortage.shortage / average);
    details.push({
      materialId: shortage.materialId,
      materialName: material.name,
      samples: samples.length,
      averagePerRun: average,
      estimatedRuns,
      estimatedDays: daysUntilRuns(material.openDays ?? [], today, estimatedRuns),
    });
  }
  return {
    days: Math.max(...details.map((item) => item.estimatedDays)),
    reason: '基于已确认背包差值的历史均值；按每个开放日执行一批估算',
    details,
  };
}

function confirmedSamples(history, domainName, materialName) {
  return (Array.isArray(history) ? history : [])
    .map((record) => record.execution)
    .filter((execution) => execution?.status === 'completed'
      && execution.task?.domainName === domainName
      && (execution.appliedGains === true || Object.keys(execution.trackedRewards ?? {}).length > 0))
    .map((execution) => Number(execution.trackedRewards?.[materialName]) || 0);
}

function daysUntilRuns(openDays, today, requiredRuns) {
  const allowed = new Set(openDays);
  let completedRuns = 0;
  for (let offset = 0; offset < 366; offset += 1) {
    if (!allowed.has((today + offset) % 7)) continue;
    completedRuns += 1;
    if (completedRuns >= requiredRuns) return offset;
  }
  return 365;
}
