import { collectCraftingMaterialIds } from './crafting.js';

/** 将已发现路线转换为可执行配置；路径必须是 AutoPathing 根目录下的相对 JSON 路径。 */
export function buildRouteExecutionPlan(routes, settings, recipes = {}) {
  if (settings.routeExecutionEnabled !== true) return [];
  const groupedByPath = new Map();
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
    for (const path of new Set(route.paths)) {
      const normalizedPath = path.replaceAll('/', '\\').toLowerCase();
      const key = `${route.type}\u0000${partyName}\u0000${normalizedPath}`;
      if (!groupedByPath.has(key)) {
        groupedByPath.set(key, {
          type: route.type,
          partyName,
          paths: [path],
          materialMap: new Map(),
        });
      }
      groupedByPath.get(key).materialMap.set(route.materialId, {
        materialId: route.materialId,
        name: route.name,
        shortage: route.shortage,
      });
    }
  }

  return [...groupedByPath.values()].map((group) => {
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
