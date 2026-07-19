import fs from 'node:fs/promises';
import path from 'node:path';
import genshinDbModule from 'genshin-db';
import { inferSundaySelectedValue } from '../core/sunday-selection.js';
import { validateDomainExecutionMap } from '../core/domain-catalog.js';

const db = genshinDbModule.default ?? genshinDbModule;
db.setOptions({
  queryLanguages: ['ChineseSimplified', 'English'],
  resultLanguage: 'ChineseSimplified',
});

const root = path.resolve(import.meta.dirname, '..');
const outputPath = path.join(root, 'data', 'rulebook.json');
const materialsPath = path.join(root, 'data', 'materials.json');
const recipesPath = path.join(root, 'data', 'crafting-recipes.json');
const executionMapPath = path.join(root, 'data', 'execution-map.json');
const sourceCandidatesPath = path.join(root, 'data', 'source-candidates.json');
const sourceExecutionMapPath = path.join(root, 'data', 'source-execution-map.json');
const domainCatalogPath = path.join(root, 'data', 'bettergi-domain-catalog.json');
const weeklyDomainCatalogPath = path.join(root, 'data', 'bettergi-weekly-domain-catalog.json');
const bossCatalogPath = path.join(root, 'data', 'bettergi-boss-catalog.json');

const characters = buildCharacters();
const weapons = buildWeapons();
const recipes = buildCraftingRecipes();
const rulebook = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: 'genshin-db',
  characters,
  weapons,
};

await fs.writeFile(outputPath, `${JSON.stringify(rulebook, null, 2)}\n`, 'utf8');
const executionMap = JSON.parse(await fs.readFile(executionMapPath, 'utf8'));
const sourceExecutionMap = JSON.parse(await fs.readFile(sourceExecutionMapPath, 'utf8'));
const domainCatalog = JSON.parse(await fs.readFile(domainCatalogPath, 'utf8'));
const weeklyDomainCatalog = JSON.parse(await fs.readFile(weeklyDomainCatalogPath, 'utf8'));
const bossCatalog = JSON.parse(await fs.readFile(bossCatalogPath, 'utf8'));
validateDomainExecutionMap(sourceExecutionMap, domainCatalog);
const materials = buildMaterials(rulebook, executionMap, sourceExecutionMap, weeklyDomainCatalog, bossCatalog, recipes);
const sourceCandidates = buildSourceCandidates(materials);
await fs.writeFile(materialsPath, `${JSON.stringify(materials, null, 2)}\n`, 'utf8');
await fs.writeFile(recipesPath, `${JSON.stringify(recipes, null, 2)}\n`, 'utf8');
await fs.writeFile(sourceCandidatesPath, `${JSON.stringify(sourceCandidates, null, 2)}\n`, 'utf8');
console.log(`已生成规则库：${Object.keys(characters).length} 名角色，${Object.keys(weapons).length} 把武器，${Object.keys(materials).length} 项材料，${Object.keys(recipes).length} 条合成配方，${Object.keys(sourceCandidates).length} 项来源候选`);

function buildCharacters() {
  const result = {};
  for (const name of db.characters('names', { matchCategories: true })) {
    const character = db.characters(name);
    const talents = db.talents(name);
    if (character?.name && character.costs && talents?.costs) {
      result[character.name] = {
        id: character.id,
        ascensionCosts: character.costs,
        talentCosts: talents.costs,
      };
    }
  }
  return result;
}

function buildWeapons() {
  const result = {};
  for (const name of db.weapons('names', { matchCategories: true })) {
    const weapon = db.weapons(name);
    if (weapon?.name && weapon.costs) {
      result[weapon.name] = {
        id: weapon.id,
        ascensionCosts: weapon.costs,
      };
    }
  }
  return result;
}

function buildMaterials(rulebook, executionMap, sourceExecutionMap, weeklyDomainCatalog, bossCatalog, recipes) {
  const materials = {};
  const items = new Map(collectCostItems(rulebook).map((item) => [item.id, item]));
  collectRecipeInputs(items, recipes);
  for (const item of items.values()) {
    const defaultDefinition = isExcluded(item)
      ? { name: item.name, status: 'excluded', executionType: 'none', reason: '不在自动刷取范围内' }
      : buildExecutionDefinition(item, sourceExecutionMap, weeklyDomainCatalog, bossCatalog, recipes);
    // 单材料显式配置优先级最高，可用于后续修正或用户覆盖。
    materials[item.id] = { ...defaultDefinition, ...(executionMap[item.id] ?? {}) };
  }
  return materials;
}

function buildExecutionDefinition(item, sourceExecutionMap, weeklyDomainCatalog, bossCatalog, recipes) {
  const weeklyDomain = (weeklyDomainCatalog.domains ?? []).find((domain) => domain.rewards?.includes(item.name));
  if (weeklyDomain) {
    return {
      name: item.name,
      status: 'supported',
      executionType: 'weeklyBoss',
      domainName: weeklyDomain.domainName,
      openDays: [0, 1, 2, 3, 4, 5, 6],
      limited: false,
      priority: 200,
      reason: 'BetterGI 内置征讨领域奖励表对照；待实机回归',
    };
  }
  const bossName = findSupportedBossName(item, bossCatalog);
  if (bossName) {
    return {
      name: item.name,
      status: 'supported',
      executionType: 'boss',
      bossName,
      openDays: [0, 1, 2, 3, 4, 5, 6],
      limited: false,
      priority: 150,
      reason: '游戏内掉落来源与 BetterGI 内置自动首领名称精确对照；待实机回归',
    };
  }
  const material = findDomainMaterial(item.name, recipes);
  // 同一系列的各阶材料有不同 dropDomainId，但共用同一奖励关卡名称。
  const domain = material?.dropDomainName && sourceExecutionMap.domains?.[material.dropDomainName];
  if (domain) {
    const openDays = toWeekdayNumbers(material.daysOfWeek);
    return {
      name: item.name,
      status: 'supported',
      executionType: 'domain',
      domainName: domain.domainName,
      // 特殊情况可在 source-execution-map.json 覆盖；常规顺序按开放日自动推导。
      sundaySelectedValue: domain.sundaySelectedValue ?? inferSundaySelectedValue(openDays),
      openDays,
      limited: true,
      priority: domain.priority ?? 0,
      reason: domain.verification,
    };
  }
  return { name: item.name, status: 'manual', executionType: 'none', reason: '尚未配置已验证的执行适配' };
}

function findSupportedBossName(item, bossCatalog) {
  if (!String(item.id).startsWith('113')) return '';
  const sources = db.materials(item.name)?.sources ?? [];
  const candidates = sources.filter((source) => source.includes('掉落')).flatMap(toRouteNames);
  return (bossCatalog.bosses ?? []).find((bossName) => candidates.includes(bossName)) ?? '';
}

/**
 * 中高阶天赋书和武器材料的游戏数据通常没有直接填写秘境字段，
 * 沿 3:1 配方追溯到低阶材料后继承其秘境与开放日。
 */
function findDomainMaterial(name, recipes, visited = new Set()) {
  const material = db.materials(name);
  if (!material?.id || visited.has(String(material.id))) return null;
  if (material.dropDomainId) return material;
  visited.add(String(material.id));
  for (const input of recipes[String(material.id)]?.inputs ?? []) {
    const result = findDomainMaterial(input.name, recipes, visited);
    if (result) return result;
  }
  return null;
}

function toWeekdayNumbers(days) {
  const values = { 周日: 0, 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6 };
  return (days ?? []).map((day) => values[day]).filter((day) => day !== undefined);
}

function buildCraftingRecipes() {
  const recipes = {};
  for (const craft of db.crafts('names', { matchCategories: true, verboseCategories: true })) {
    const output = db.materials(craft.name);
    if (!output?.id || !Array.isArray(craft.recipe) || craft.recipe.length !== 1 || !craft.resultCount) continue;
    recipes[String(output.id)] = {
      resultCount: craft.resultCount,
      inputs: craft.recipe.map((input) => ({ id: String(input.id), name: input.name, count: input.count })),
    };
  }
  return recipes;
}

function collectRecipeInputs(items, recipes) {
  const pending = [...items.keys()];
  while (pending.length > 0) {
    const materialId = pending.pop();
    for (const input of recipes[materialId]?.inputs ?? []) {
      if (items.has(input.id)) continue;
      const material = db.materials(input.id);
      if (!material?.id || !material?.name) continue;
      items.set(String(material.id), { id: String(material.id), name: material.name });
      pending.push(String(material.id));
    }
  }
}

function collectCostItems(rulebook) {
  const byId = new Map();
  for (const character of Object.values(rulebook.characters)) {
    collectCosts(character.ascensionCosts, byId);
    collectCosts(character.talentCosts, byId);
  }
  for (const weapon of Object.values(rulebook.weapons)) collectCosts(weapon.ascensionCosts, byId);
  return [...byId.values()];
}

function collectCosts(costGroups, byId) {
  for (const costs of Object.values(costGroups)) {
    for (const item of costs) byId.set(String(item.id), { id: String(item.id), name: item.name });
  }
}

function isExcluded(item) {
  if (item.name === '摩拉') return true;
  return ['哀叙冰玉', '涤净青金', '坚牢黄玉', '最胜紫晶', '燃愿玛瑙', '生长碧翡', '自在松石']
    .some((gemName) => item.name.startsWith(gemName));
}

/**
 * 生成“游戏内来源”的候选信息，不把候选直接当成可执行配置。
 * 秘境展示奖励关卡名；是否可传送到 BetterGI 具体秘境由后续映射表决定。
 */
function buildSourceCandidates(materials) {
  const result = {};
  for (const [materialId, definition] of Object.entries(materials)) {
    if (definition.status === 'excluded') continue;
    const material = db.materials(definition.name);
    if (!material?.id) continue;
    const sources = material.sources ?? [];
    const base = { materialId, name: definition.name, sources };

    if (material.dropDomainName) {
      result[materialId] = {
        ...base,
        type: 'domain',
        domainId: material.dropDomainId,
        gameDomainName: material.dropDomainName,
        daysOfWeek: material.daysOfWeek ?? [],
      };
      continue;
    }

    if (materialId.startsWith('100')) {
      result[materialId] = { ...base, type: 'localSpecialty', routeNames: [definition.name] };
      continue;
    }

    const dropSources = sources.filter((source) => source.includes('掉落'));
    if (materialId.startsWith('112') && dropSources.length > 0) {
      result[materialId] = {
        ...base,
        type: 'monster',
        routeNames: unique(dropSources.flatMap(toRouteNames).filter(Boolean)),
      };
      continue;
    }

    if (materialId.startsWith('113') && dropSources.length > 0) {
      const weekly = sources.some((source) => source.includes('挑战奖励'));
      result[materialId] = {
        ...base,
        type: weekly ? 'weeklyBoss' : 'worldBoss',
        bossNames: unique(dropSources.flatMap(toRouteNames).filter(Boolean)),
      };
    }
  }
  return result;
}

function toRouteNames(source) {
  const name = source
    .replace(/^\d+级以上/, '')
    .replace(/掉落$/, '')
    .replace(/少量$/, '')
    .trim();
  // scripts-repo 的路线目录有时只保留“·”后的怪物名，例如“债务处理人”。
  return [name, name.split('·').at(-1)];
}

function unique(values) {
  return [...new Set(values)];
}
