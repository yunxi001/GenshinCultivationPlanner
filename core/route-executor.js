import { collectCraftingMaterialIds } from './crafting.js';

/** 将已发现路线转换为可执行配置；路径必须是 AutoPathing 根目录下的相对 JSON 路径。 */
export function buildRouteExecutionPlan(routes, settings, recipes = {}) {
  if (settings.routeExecutionEnabled !== true) return [];
  const groupedByRoute = new Map();
  for (const route of routes?.matched ?? []) {
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
    const pathsByNormalizedName = new Map();
    for (const path of route.paths) {
      const normalizedPath = path.replaceAll('/', '\\').toLowerCase();
      if (!pathsByNormalizedName.has(normalizedPath)) pathsByNormalizedName.set(normalizedPath, path);
    }
    const normalizedPaths = [...pathsByNormalizedName.keys()].sort();
    const key = `${route.type}\u0000${partyName}\u0000${normalizedPaths.join('\u0001')}`;
    if (!groupedByRoute.has(key)) {
      groupedByRoute.set(key, {
        type: route.type,
        partyName,
        paths: [...pathsByNormalizedName.values()],
        materialMap: new Map(),
      });
    }
    groupedByRoute.get(key).materialMap.set(route.materialId, {
      materialId: route.materialId,
      name: route.name,
      shortage: route.shortage,
    });
  }

  return [...groupedByRoute.values()].map((group) => {
    const materials = [...group.materialMap.values()];
    const requirements = new Map(materials.map((item) => [item.materialId, 1]));
    return {
      type: group.type,
      partyName: group.partyName,
      paths: group.paths,
      materials,
      name: materials.map((item) => item.name).join('、'),
      scanMaterialIds: collectCraftingMaterialIds(requirements, recipes),
    };
  });
}

/** 已订阅路线必须从 User/AutoPathing 根目录执行，不能按当前 JS 脚本目录解析。 */
export async function runSubscribedRouteFile(pathing, routePath) {
  if (!pathing?.isFile?.(routePath)) {
    throw new Error(`已订阅路线文件不存在：${routePath}`);
  }
  if (typeof pathing.runFileFromUser !== 'function') {
    throw new Error('当前 BetterGI 不支持从 User/AutoPathing 执行订阅路线');
  }
  await pathing.runFileFromUser(routePath);
}

export function areRouteTargetsSatisfied(materials, confirmedGains) {
  return materials.length > 0 && materials.every((item) => (
    (confirmedGains[item.materialId] ?? 0) >= item.shortage
  ));
}
