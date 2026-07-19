const UNLIMITED_USE_COUNT = 9999;

/** 构造征讨领域任务：周本不使用浓缩、须臾或脆弱树脂。 */
export function buildWeeklyBossExecutionConfig(task, settings) {
  if (task?.executionType !== 'weeklyBoss' || !task.domainName) {
    throw new Error('周本任务缺少已验证的征讨领域名称');
  }
  const partyName = settings.weeklyBossTeamName?.trim() || settings.bossTeamName?.trim();
  if (!partyName) throw new Error(`周本“${task.domainName}”未配置周本队伍或 Boss 队伍`);
  return {
    domainName: task.domainName,
    partyName,
    strategyName: settings.weeklyBossCombatStrategyName?.trim() || settings.bossCombatStrategyName?.trim() || '',
    originalResinUseCount: UNLIMITED_USE_COUNT,
    trackedMaterials: task.materials ?? [{ materialId: task.materialId, materialName: task.materialName, shortage: task.shortage }],
  };
}
