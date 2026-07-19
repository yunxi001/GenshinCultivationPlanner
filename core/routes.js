/**
 * 从 BetterGI 已订阅的 AutoPathing 目录中查找路线。
 * 此模块只做发现和计划，不执行路径。
 */
export function discoverAutoPathingRoutes({ shortages, sourceCandidates = {}, pathing, routeOverrides = {} }) {
  const matched = [];
  const missing = [];
  for (const shortage of shortages) {
    if (!shortage.shortage || shortage.shortage <= 0) continue;
    const candidate = sourceCandidates[shortage.materialId];
    if (!candidate || !['localSpecialty', 'monster'].includes(candidate.type)) continue;

    const overridden = normalizeOverride(routeOverrides[shortage.materialId]);
    const paths = overridden.length > 0 ? overridden : findSubscribedPaths(candidate, pathing);
    const item = {
      materialId: shortage.materialId,
      name: candidate.name,
      type: candidate.type,
      shortage: shortage.shortage,
      paths,
      source: overridden.length > 0 ? 'manualOverride' : 'autoDiscovered',
    };
    if (paths.length > 0) matched.push(item);
    else missing.push({ ...item, reason: '未在已订阅的 AutoPathing 路线中找到同名目录' });
  }
  return { matched, missing };
}

function findSubscribedPaths(candidate, pathing) {
  if (!pathing?.readPaths || !pathing?.isFolder || !pathing?.isFile) return [];
  if (candidate.type === 'localSpecialty') {
    return candidate.routeNames.flatMap((name) => findLocalSpecialtyPaths(name, pathing));
  }
  return unique(candidate.routeNames.flatMap((name) => findFiles(`${'敌人与魔物'}/${name}`, pathing)));
}

function findLocalSpecialtyPaths(name, pathing) {
  return unique(pathing.readPaths('地方特产')
    .filter((path) => pathing.isFolder(path))
    .flatMap((country) => findFiles(`${country}/${name}`, pathing)));
}

function findFiles(folder, pathing) {
  if (!pathing.isFolder(folder)) return [];
  return pathing.readPaths(folder)
    .filter((path) => path.toLowerCase().endsWith('.json'))
    .filter((path) => pathing.isFile(path));
}

function normalizeOverride(override) {
  if (typeof override === 'string') return [override];
  if (Array.isArray(override)) return override.filter((path) => typeof path === 'string' && path.trim());
  return [];
}

function unique(values) {
  return [...new Set(values)];
}
