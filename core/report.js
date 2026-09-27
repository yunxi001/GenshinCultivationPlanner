import { normalizeLegacyExecution } from './execution-outcome.js';

export function buildRunStartSummary() {
  return '角色一键养成已开始\n正在读取培养目标并生成执行计划。';
}

export function shouldSendRunNotifications(settings = {}) {
  return settings.sendRunSummary === true && settings.targetInputMode !== '自动档案仅预览';
}

export function limitNotificationMessage(message, limit = 500) {
  const text = String(message ?? '');
  if (text.length <= limit) return text;
  let result = '';
  for (const character of text) {
    if (result.length + character.length + 1 > limit) break;
    result += character;
  }
  return `${result}…`;
}

/** 这里只报告计划，不把领奖上限或候选任务写成实际执行结果。 */
export function buildPlanReadySummary({ targetCount = 0, targetSummary = [], queue = [] } = {}) {
  const tasks = queue.slice(0, 4).map((item) => {
    const name = String(item.targetName ?? '未命名任务').slice(0, 40);
    const limit = item.maxClaims == null ? '计划使用可用预算' : `计划最多领奖${item.maxClaims}次`;
    return `\n• ${name}（${limit}）`;
  });
  const prefix = '角色一键养成计划已就绪'
    + `\n培养目标：${Number(targetCount) || 0} 项`
    + `\n计划树脂任务：${queue.length} 项${tasks.join('')}`;
  const suffix = '\n以上仅为计划；结束摘要会报告确认收益或未确认结果。';
  const details = Array.isArray(targetSummary)
    ? targetSummary.filter((item) => typeof item === 'string' && item.trim()).map((item) => `\n• ${item.trim()}`).join('')
    : '';
  const section = '\n培养计划';
  const detailBudget = 500 - prefix.length - section.length - suffix.length;
  const fittedDetails = details && detailBudget > 1 ? limitNotificationMessage(details, detailBudget) : '';
  return `${prefix}${fittedDetails ? `${section}${fittedDetails}` : ''}${suffix}`;
}

/** 生成未处理异常的简短通知；只在用户已确认执行后调用。 */
export function buildFailureRunSummary({ stage = '运行过程中', targets = [], reason = '未知错误' } = {}) {
  const targetText = Array.isArray(targets) && targets.length > 0 ? targets.join('、') : '未确认';
  const prefix = '角色一键养成运行失败'
    + `\n\n培养目标：${truncateText(targetText, 80)}`
    + `\n失败阶段：${truncateText(stage, 40)}`
    + '\n失败原因：';
  const suffix = '\n\n请查看 BetterGI 日志。';
  const reasonLimit = Math.max(1, 500 - prefix.length - suffix.length);
  return `${prefix}${truncateText(reason, reasonLimit)}${suffix}`;
}

/**
 * 生成 BetterGI 通知摘要。通知接口限制为 500 字符，详细数据仍写入 latest-plan.json。
 */
export function buildRunSummary(plan, materials, {
  executionEnabled = false,
  estimateDays = null,
  estimateReason = '',
  estimateDetails = [],
  execution = null,
} = {}) {
  execution = normalizeLegacyExecution(execution);
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
  const unknownMaterials = (plan.displayShortages ?? plan.shortages ?? [])
    .filter((item) => item.status === 'unknown')
    .map((item) => `${materials[item.materialId]?.name ?? item.material?.name ?? item.materialId}（库存未确认）`);
  const remaining = [...missing, ...unknownMaterials];
  const manualWeekly = (plan.manualItems ?? [])
    .filter((item) => item.material?.executionType === 'weeklyBoss' && item.shortage > 0)
    .map((item) => `${materials[item.materialId]?.name ?? item.material?.name ?? item.materialId}×${item.shortage}`);
  const estimate = formatEstimate(estimateDays, estimateReason, estimateDetails);
  const hasUnknownMaterial = unknownMaterials.length > 0;
  const materialsSatisfied = missing.length === 0 && manualWeekly.length === 0 && !hasUnknownMaterial;
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
  const routeAdvice = [
    ...(plan.routeSubscriptions?.available ?? []).map((item) => (
      `${item.name}（${item.requiresChoice ? '多版本待选择' : '可订阅'}）`
    )),
    ...(plan.routeSubscriptions?.unavailable ?? []).map((item) => `${item.name}（暂无可靠路线）`),
  ];
  const hasRouteFailure = (execution?.routes ?? []).some((route) => route.status === 'failed');
  const hasUnconfirmedRoute = (execution?.routes ?? []).some((route) => route.status === 'unconfirmed');
  const hasRouteExecution = (execution?.routes ?? []).length > 0;
  const taskResult = formatTaskResult(execution);
  const warnings = (execution?.warnings ?? []).map((warning) => (
    `${warning.targetName ? `${warning.targetName}：` : ''}${warning.message || warning.code}`
  ));
  const action = !executionEnabled
    ? '本次未执行'
    : execution?.status === 'failed'
      ? `执行失败：${execution.reason || '未提供失败原因'}`
      : execution?.status === 'unconfirmed'
        ? taskResult.status
      : hasRouteFailure
        ? taskResult.tasks.length > 0
          ? `${taskResult.status}；存在路线执行错误`
          : '部分执行失败：存在路线执行错误'
        : hasUnconfirmedRoute
          ? taskResult.tasks.length > 0
            ? `${taskResult.status}；部分路线未确认材料增长`
            : '已执行路线任务；部分路线未确认材料增长'
          : execution?.status === 'skipped' && hasRouteExecution
            ? '已执行路线任务'
      : execution?.status === 'skipped' && materialsSatisfied
        ? '无需执行：培养材料已满足'
      : execution?.status === 'skipped'
        ? `未执行：${execution.reason || '没有可执行任务'}`
        : taskResult.status;
  const inventoryIssueNames = execution?.inventoryUnrecognizedNames ?? [];
  const hasTaskRecognitionGain = Object.values(execution?.gainSources ?? {}).includes('task-recognition');
  const onlyArtifactTasks = (execution?.tasks?.length ?? 0) > 0
    && execution.tasks.every((task) => task.taskType === 'artifactDomain');
  const confirmedGainFallback = onlyArtifactTasks
    ? '圣遗物收益不纳入培养材料计数'
    : execution?.inventoryRecognitionFailed === true && !hasTaskRecognitionGain
      ? `奖励结果未知（背包未识别：${inventoryIssueNames.join('、') || '目标材料'}）`
    : execution?.task
      ? '未确认领取到目标材料，可能是树脂不足或奖励识别为空'
      : '无';
  const sections = [
    '养成材料调度摘要',
    `\n本次状态：${action}`,
    (plan.targetSummary ?? []).length > 0
      ? `\n\n培养档案${formatItems(plan.targetSummary, '无')}`
      : '',
    `\n\n本次任务${formatItems(taskResult.tasks, '无树脂任务')}`,
    `\n\n确认收益${formatItems(gains, confirmedGainFallback)}`,
    `\n\n路线结果${formatItems(routeResults, '本次无路线任务')}`,
    warnings.length > 0 ? `\n\n运行警告${formatItems(warnings, '无')}` : '',
    manualWeekly.length > 0
      ? `\n\n需手动获取的周本材料${formatItems(manualWeekly, '无')}`
      : '',
    `\n\n仍缺材料${formatItems(remaining, '无')}`,
    `\n\n${estimate}`,
    `\n\n今日可执行任务${formatItems(planned, '无')}`,
    `\n\n本周循环策略${formatItems(weekly, '本周无可执行树脂任务')}`,
    routeAdvice.length > 0
      ? `\n\n待准备路线${formatItems(routeAdvice.slice(0, 3), '无')}${routeAdvice.length > 3 ? `\n• 另有${routeAdvice.length - 3}项，详见路线订阅建议文件` : ''}`
      : '',
  ];
  let summary = '';
  for (const section of sections) {
    if (!section) continue;
    if (summary.length + section.length > 500) {
      const ellipsis = '\n…';
      return summary.length + ellipsis.length <= 500 ? `${summary}${ellipsis}` : summary;
    }
    summary += section;
  }
  return summary;
}

function formatTaskResult(execution) {
  const task = execution?.task;
  const tasks = execution?.tasks?.length > 0
    ? execution.tasks.map(formatOutcomeTask)
    : task ? [formatTask(task)] : [];
  if (!task) return { status: execution?.status === 'skipped' ? '本次无树脂任务' : '任务未完成', tasks };
  if (execution?.status === 'failed') return { status: `任务失败：${execution.message || execution.reason || '未知原因'}`, tasks };
  if (execution?.status === 'skipped') return { status: `任务已跳过：${execution.message || execution.reason || '未提供原因'}`, tasks };
  if (execution?.status === 'unconfirmed') return { status: `任务结果未确认：${execution.message || execution.reason || '未确认领取奖励'}`, tasks };
  if (task.executionType === 'artifactDomain') {
    return { status: '圣遗物任务调用结束；收益不纳入培养材料统计', tasks };
  }
  if (Object.values(execution.gainSources ?? {}).includes('task-recognition')) {
    return { status: '已确认收益；部分材料由 BetterGI 奖励识别补充确认', tasks };
  }
  if (execution.inventoryRecognitionFailed === true) {
    const names = (execution.inventoryUnrecognizedNames ?? []).join('、') || '目标材料';
    return {
      status: execution.appliedGains === true
        ? `已确认部分收益；部分材料背包识别失败（${names}）`
        : `任务调用结束；奖励结果未知（背包未识别：${names}）`,
      tasks,
    };
  }
  if (execution.inventoryChecked === true && execution.appliedGains === true) {
    return { status: '已由背包差值确认收益', tasks };
  }
  return { status: '未确认领取到目标材料，可能是树脂不足或奖励识别为空', tasks };
}

function formatOutcomeTask(outcome) {
  const labels = {
    domain: '培养秘境',
    artifactDomain: '圣遗物秘境',
    boss: '世界 Boss',
    route: '路线',
  };
  const statuses = {
    completed: '已完成',
    unconfirmed: '未确认',
    skipped: '已跳过',
    failed: '失败',
  };
  return `${labels[outcome.taskType] ?? '树脂任务'}：${outcome.targetName ?? '未命名任务'}（${statuses[outcome.status] ?? outcome.status}）`;
}

function formatTask(task) {
  const name = task.domainName ?? task.bossName ?? task.materialName ?? '未命名任务';
  const labels = {
    domain: '培养秘境',
    artifactDomain: '圣遗物秘境',
    boss: '世界 Boss',
  };
  return `${labels[task.executionType] ?? '树脂任务'}：${name}`;
}

function formatEstimate(days, reason, details) {
  if (days === 0 && reason === '材料已满足') return '预计完成：培养材料已满足';
  if (!Number.isFinite(days)) return `预计完成：${reason || '等待累计实际掉落数据'}`;
  if (details.length === 1) {
    const detail = details[0];
    if (detail.sourceType === 'route') {
      return `预计完成：${detail.sourceName}约需${detail.estimatedRuns}次路线运行、约${days}天（依据近${detail.sampleCount}次背包增量；仅供参考）`;
    }
    if (detail.sourceType === 'boss') {
      return `预计完成：约${detail.estimatedClaims}次领奖、${detail.estimatedResin}树脂；按每日树脂预算约${detail.requiredOpenDays}天（${reason || '按掉落期望估算'}）`;
    }
    const calendar = days === 0
      ? '当前开放日可刷；若本次树脂已用完则等待下一个开放日'
      : `从现在起最早约${days}个自然日`;
    return `预计完成：约${detail.estimatedClaims}次领奖、${detail.estimatedResin}树脂、${detail.requiredOpenDays}个开放日；${calendar}（${reason || '按掉落期望估算'}）`;
  }
  if (details.some((detail) => detail.sourceType === 'route')) {
    return `预计完成：可估算部分约${days}天（${reason || '按历史收益估算'}）`;
  }
  return days === 0
    ? `预计完成：当前开放日可刷；实际完成时间取决于剩余树脂（${reason || '按掉落期望估算'}）`
    : `预计完成：从现在起最早约${days}个自然日（${reason || '按掉落期望估算'}）`;
}

function formatItems(items, emptyText) {
  if (!items.length) return `\n• ${emptyText}`;
  return items.map((item) => `\n• ${item}`).join('');
}

function truncateText(value, limit) {
  let result = '';
  for (const character of String(value ?? '')) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}
