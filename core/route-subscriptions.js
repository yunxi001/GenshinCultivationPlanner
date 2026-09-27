/**
 * 路线订阅助手只生成建议，不下载文件，也不自动触发 BetterGI 导入。
 * 目录由官方仓库的指定 Git 提交生成，路径仍须由 BetterGI 原生界面确认。
 */
export function buildRouteSubscriptionPlan(routes, catalog) {
  const result = {
    sourceRevision: catalog?.sourceRevision ?? null,
    installed: (routes?.matched ?? []).map((route) => ({
      materialId: String(route.materialId), name: route.name, type: route.type,
      pathCount: route.paths?.length ?? 0,
    })),
    available: [],
    unavailable: [],
  };
  for (const route of routes?.missing ?? []) {
    if (!(route.shortage > 0)) continue;
    const entry = catalog?.materials?.[route.materialId];
    const packages = entry?.type === route.type && entry?.name === route.name
      ? (entry.packages ?? []).filter(isValidPackage)
      : [];
    const item = {
      materialId: String(route.materialId), name: route.name, type: route.type,
      shortage: route.shortage,
    };
    if (packages.length === 0) {
      result.unavailable.push({ ...item, reason: '当前目录没有可核对的官方路线包' });
    } else {
      result.available.push({
        ...item,
        requiresChoice: packages.length > 1,
        packages: packages.map((candidate) => ({
          variant: candidate.variant,
          repoPaths: candidate.repoPaths,
          fileCount: candidate.fileCount,
          importLink: candidate.importLink,
        })),
      });
    }
  }
  return result;
}

export function formatRouteSubscriptionText(suggestions) {
  const lines = [
    '角色一键养成 · 路线订阅建议',
    `官方目录版本：${suggestions?.sourceRevision ?? '未知'}`,
    '本文件只提供建议；请先更新 BetterGI 脚本仓库，再由原生确认界面决定是否导入。',
    '多作者或特殊队伍路线需自行选择；脚本不会自动下载或订阅。',
  ];
  if (!(suggestions?.available?.length || suggestions?.unavailable?.length)) {
    lines.push('', '当前没有仍缺且未安装的地方特产或怪物材料路线。');
  }
  for (const item of suggestions?.available ?? []) {
    lines.push('', `${item.name}（缺 ${item.shortage}，${item.type === 'localSpecialty' ? '地方特产' : '怪物材料'}）`);
    if (item.requiresChoice) lines.push('发现多个版本，请检查作者、角色要求和路线说明后选择其一：');
    for (const candidate of item.packages) {
      lines.push(`- ${candidate.variant}（${candidate.fileCount} 个 JSON）：${candidate.repoPaths.join('；')}`);
      lines.push(`  原生导入链接：${candidate.importLink}`);
    }
  }
  for (const item of suggestions?.unavailable ?? []) {
    lines.push('', `${item.name}（缺 ${item.shortage}）：${item.reason}；可使用手动路线覆盖。`);
  }
  return `${lines.join('\n')}\n`;
}

function isValidPackage(candidate) {
  return Array.isArray(candidate.repoPaths)
    && candidate.repoPaths.length > 0
    && candidate.repoPaths.every((value) => typeof value === 'string'
      && value.startsWith('pathing/')
      && !value.includes('\\')
      && value.split('/').every((part) => part && part !== '.' && part !== '..'))
    && typeof candidate.importLink === 'string'
    && candidate.importLink.startsWith('bettergi://script?import=');
}
