/**
 * 生成 BetterGI 通知摘要。通知接口限制为 500 字符，详细数据仍写入 latest-plan.json。
 */
export function buildRunSummary(plan, materials, { executionEnabled = false, estimateDays = null, estimateReason = '', execution = null } = {}) {
  const planned = plan.todayQueue
    .map((task) => task.materials?.length
      ? `${task.domainName ?? task.bossName ?? task.materialName}：${task.materials.map((item) => `${item.materialName}×${item.shortage}`).join('/')}`
      : task.executionType === 'artifactDomain'
        ? `${task.domainName}（圣遗物填充）`
        : `${materials[task.materialId]?.name ?? task.materialName ?? task.materialId}(${task.shortage})`)
    || [];
  const missing = (plan.displayShortages ?? plan.shortages)
    .filter((item) => item.shortage > 0)
    .map((item) => `${materials[item.materialId]?.name ?? item.materialId}×${item.shortage}`)
    || [];
  const estimate = Number.isFinite(estimateDays)
    ? `预计完成：约${estimateDays}天（${estimateReason || '按历史均值估算'}）`
    : `预计完成：${estimateReason || '等待累计实际掉落数据'}`;
  const gains = execution?.trackedRewards && Object.keys(execution.trackedRewards).length > 0
    ? Object.entries(execution.trackedRewards).map(([name, count]) => `${name}×${count}`)
    : [];
  const weekly = (plan.weeklyStrategy ?? []).map((item) => `${item.label}：${item.tasks
    .map((task) => task.domainName ?? task.materialName ?? task.materialId).join('、')}`);
  const routeGroups = new Map();
  for (const route of execution?.routes ?? []) {
    if (!routeGroups.has(route.name)) routeGroups.set(route.name, { statuses: [], reasons: [], gained: {} });
    const group = routeGroups.get(route.name);
    group.statuses.push(route.status);
    if (route.reason) group.reasons.push(route.reason);
    for (const [name, count] of Object.entries(route.gained ?? {})) {
      group.gained[name] = (group.gained[name] ?? 0) + count;
    }
  }
  const routeResults = [...routeGroups.entries()].map(([name, route]) => {
    if (route.statuses.includes('failed')) return `${name}：失败（${route.reasons[0] || '未知原因'}）`;
    const routeGains = Object.entries(route.gained)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${name}×${count}`)
      .join('、');
    if (!routeGains && route.statuses.includes('unconfirmed')) return `${name}：未确认增长`;
    return `${name}：${routeGains || '已完成'}`;
  });
  const hasRouteFailure = (execution?.routes ?? []).some((route) => route.status === 'failed');
  const hasUnconfirmedRoute = (execution?.routes ?? []).some((route) => route.status === 'unconfirmed');
  const hasRouteExecution = (execution?.routes ?? []).length > 0;
  const action = !executionEnabled
    ? '仅生成计划，未刷取'
    : execution?.status === 'failed'
      ? `执行失败：${execution.reason || '未提供失败原因'}`
      : hasRouteFailure
        ? '部分执行失败：存在路线执行错误'
        : hasUnconfirmedRoute
          ? '已执行；部分路线未确认材料增长'
          : execution?.status === 'skipped' && hasRouteExecution
            ? '已执行路线任务'
      : execution?.status === 'skipped'
        ? `未执行：${execution.reason || '没有可执行任务'}`
        : execution?.rewardRecognitionFailed && execution?.appliedGains !== true
          ? '已执行；奖励/背包复核未确认'
          : '已执行完成';
  const sections = [
    '<b>养成材料调度摘要</b>',
    `<br><b>本次状态</b>：${action}`,
    `<br><br><b>本次刷取</b>${formatItems(gains, '本次无已确认收益')}`,
    `<br><br><b>路线结果</b>${formatItems(routeResults, '本次无路线任务')}`,
    `<br><br><b>仍缺材料</b>${formatItems(missing, '无')}`,
    `<br><br><b>下一步候选</b>${formatItems(planned, '无')}`,
    `<br><br><b>本周循环策略</b>${formatItems(weekly, '本周无可执行树脂任务')}`,
    `<br><br><b>${estimate}</b>`,
  ];
  let summary = '';
  for (const section of sections) {
    if (summary.length + section.length > 500) return `${summary}<br>…`;
    summary += section;
  }
  return summary;
}

function formatItems(items, emptyText) {
  if (!items.length) return `<br>• ${emptyText}`;
  return items.map((item) => `<br>• ${item}`).join('');
}
