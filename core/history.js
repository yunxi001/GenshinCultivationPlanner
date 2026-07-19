const MAX_HISTORY_ENTRIES = 100;

/** 保存精简运行记录，避免历史文件无限增长。 */
export function appendRunHistory(history, record) {
  const previous = Array.isArray(history) ? history : [];
  return [...previous, record].slice(-MAX_HISTORY_ENTRIES);
}

/** 将本次运行中与复盘有关的数据固定为可持久化的 JSON。 */
export function buildRunRecord({ executionEnabled, plan, inventoryBefore, inventoryAfter, execution, domainResinPolicy }) {
  return {
    timestamp: new Date().toISOString(),
    executionEnabled,
    execution: execution ? {
      status: execution.status,
      reason: execution.reason ?? null,
      task: execution.task ? {
        executionType: execution.task.executionType,
        domainName: execution.task.domainName ?? null,
        materialName: execution.task.materialName,
        materials: execution.task.materials ?? [],
      } : null,
      trackedRewards: execution.trackedRewards ?? {},
      routes: execution.routes ?? [],
      appliedGains: execution.appliedGains === true,
      rewardRecognitionFailed: execution.rewardRecognitionFailed === true,
    } : null,
    domainResinPolicy,
    inventoryBefore,
    inventoryAfter,
    remainingShortages: (plan.displayShortages ?? [])
      .filter((item) => item.shortage > 0)
      .map((item) => ({ materialId: item.materialId, shortage: item.shortage })),
  };
}
