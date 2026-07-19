/** 将已发现路线转换为可执行配置；路径必须是 AutoPathing 根目录下的相对 JSON 路径。 */
export function buildRouteExecutionPlan(routes, settings) {
  if (settings.routeExecutionEnabled !== true) return [];
  return (routes?.matched ?? []).map((route) => {
    const partyName = route.type === 'localSpecialty'
      ? settings.gatheringTeamName?.trim()
      : settings.monsterTeamName?.trim();
    if (!partyName) {
      const label = route.type === 'localSpecialty' ? '采集队伍' : '怪物材料队伍';
      throw new Error(`路线“${route.name}”未配置${label}`);
    }
    if (!Array.isArray(route.paths) || route.paths.length === 0) {
      throw new Error(`路线“${route.name}”没有可执行的 JSON 文件`);
    }
    return { ...route, partyName, paths: [...new Set(route.paths)] };
  });
}
