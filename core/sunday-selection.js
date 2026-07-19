/**
 * BetterGI 周日秘境奖励列表按周一/周四、周二/周五、周三/周六三组依次排列。
 * 返回值对应 AutoDomainParam.SundaySelectedValue 的第 1/2/3 项。
 */
export function inferSundaySelectedValue(openDays) {
  const days = new Set(openDays ?? []);
  if (days.has(1) || days.has(4)) return '1';
  if (days.has(2) || days.has(5)) return '2';
  if (days.has(3) || days.has(6)) return '3';
  return '';
}
