/**
 * 生成 BetterGI 通知摘要。通知接口限制为 500 字符，详细数据仍写入 latest-plan.json。
 */
export function buildRunSummary(plan, materials, { executionEnabled = false, estimateDays = null, estimateReason = '', execution = null } = {}) {
  const planned = plan.todayQueue
    .map((task) => task.materials?.length
      ? `${task.domainName}：${task.materials.map((item) => `${item.materialName}×${item.shortage}`).join('/')}`
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
  const action = executionEnabled
    ? execution?.rewardRecognitionFailed
      ? '已执行；奖励/背包复核未确认'
      : '已执行完成'
    : '仅生成计划，未刷取';
  const sections = [
    '<b>养成材料调度摘要</b>',
    `<br><b>本次状态</b>：${action}`,
    `<br><br><b>本次刷取</b>${formatItems(gains, '本次无已确认收益')}`,
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
