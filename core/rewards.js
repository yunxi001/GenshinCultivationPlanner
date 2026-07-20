/** 将 BetterGI 返回的普通对象或 .NET Dictionary 统一为“材料名 -> 数量”。 */
export function normalizeRewardMap(rawRewards) {
  if (!rawRewards) return {};

  // ClearScript 会把 .NET Dictionary 的 Count、Keys、Values 暴露为对象属性，
  // 不能直接把这些元数据当成奖励名称。
  if (rawRewards.Keys != null && Number.isFinite(Number(rawRewards.Count))) {
    const result = {};
    for (const key of rawRewards.Keys) {
      const count = Number(rawRewards[key]);
      if (Number.isFinite(count)) result[String(key)] = count;
    }
    return result;
  }

  return Object.fromEntries(Object.entries(rawRewards)
    .map(([name, count]) => [name, Number(count)])
    .filter(([, count]) => Number.isFinite(count)));
}
