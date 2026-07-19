/**
 * 实际执行前的配置检查。计划模式仅输出提醒，不切换队伍、不调用任务。
 */
export function collectExecutionWarnings(plan, settings) {
  const warnings = [];
  const types = new Set(plan.todayQueue.map((task) => task.executionType));
  if (types.has('domain') && !settings.domainTeamName?.trim()) {
    warnings.push('今日有秘境候选任务，但尚未配置秘境队伍名称');
  }
  if (types.has('domain') && settings.domainUseOriginalResin === false
    && settings.domainUseCondensedResin !== true
    && settings.domainUseTransientResin !== true
    && settings.domainUseFragileResin !== true) {
    warnings.push('今日有秘境候选任务，但所有允许使用的树脂类型均已关闭');
  }
  if (types.has('boss') && !settings.bossTeamName?.trim()) {
    warnings.push('今日有 Boss 候选任务，但尚未配置 Boss 队伍名称');
  }
  if (plan.routes?.matched?.some((item) => item.type === 'localSpecialty') && !settings.gatheringTeamName?.trim()) {
    warnings.push('已匹配地方特产路线，但尚未配置采集队伍名称');
  }
  if (plan.routes?.matched?.some((item) => item.type === 'monster') && !settings.monsterTeamName?.trim()) {
    warnings.push('已匹配怪物材料路线，但尚未配置怪物材料队伍名称');
  }
  if (settings.routeExecutionEnabled === true && !(plan.routes?.matched?.length > 0)) {
    warnings.push('已开启路线执行，但本次没有匹配到可执行路线');
  }
  return warnings;
}
