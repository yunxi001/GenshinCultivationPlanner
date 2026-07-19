/** 验证来源映射只引用 BetterGI 已知的培养材料秘境名称。 */
export function validateDomainExecutionMap(sourceExecutionMap, catalog) {
  const knownDomains = new Set(catalog?.materialDomains ?? []);
  for (const [sourceName, mapping] of Object.entries(sourceExecutionMap?.domains ?? {})) {
    if (!knownDomains.has(mapping.domainName)) {
      throw new Error(`来源“${sourceName}”配置了 BetterGI 未知秘境“${mapping.domainName}”`);
    }
  }
}
