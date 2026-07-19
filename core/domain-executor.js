/**
 * 将调度任务与用户设置转换为秘境执行配置；不直接调用 BetterGI，便于本地测试。
 */
export function buildDomainExecutionConfig(task, settings, resinPolicy) {
  if (task.executionType !== 'domain' || !task.domainName) {
    throw new Error('任务不是已映射的秘境任务');
  }
  const partyName = settings.domainTeamName?.trim();
  if (!partyName) throw new Error('未配置秘境队伍名称，已拒绝执行');
  if (resinPolicy.priority.length === 0) throw new Error('未启用任何秘境树脂类型，已拒绝执行');
  const sundaySelectedValue = task.sundaySelectedValue?.toString() ?? '';
  if (Number(settings.weekday) === 0 && !['1', '2', '3'].includes(sundaySelectedValue)) {
    throw new Error(`周日秘境“${task.domainName}”未配置正确的奖励序号，已拒绝执行以避免领取错误材料`);
  }
  return {
    domainName: task.domainName,
    partyName,
    strategyName: settings.domainCombatStrategyName?.trim() || '',
    sundaySelectedValue,
    resinPolicy,
    trackedMaterials: task.materials ?? [],
  };
}
