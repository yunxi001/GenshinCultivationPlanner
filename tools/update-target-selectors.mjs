import fs from 'node:fs/promises';
import path from 'node:path';
import genshinDbModule from 'genshin-db';

const db = genshinDbModule.default ?? genshinDbModule;
db.setOptions({
  queryLanguages: ['ChineseSimplified', 'English'],
  resultLanguage: 'ChineseSimplified',
});

const root = path.resolve(import.meta.dirname, '..');
const settingsPath = path.join(root, 'settings.json');
const rulebookPath = path.join(root, 'data', 'rulebook.json');
const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
const rulebook = JSON.parse(await fs.readFile(rulebookPath, 'utf8'));

const characterMetadata = new Map(db.characters('names', {
  matchCategories: true,
  verboseCategories: true,
}).map((item) => [item.name, item]));
const weaponMetadata = new Map(db.weapons('names', {
  matchCategories: true,
  verboseCategories: true,
}).map((item) => [item.name, item]));

const characterOptions = buildCascadeOptions({
  names: Object.keys(rulebook.characters),
  metadata: characterMetadata,
  noSelection: '不选择角色',
  groupOf: (item) => item.elementText === '无' ? '旅行者' : `${item.elementText}元素`,
  groupOrder: ['火元素', '水元素', '风元素', '雷元素', '草元素', '冰元素', '岩元素', '旅行者'],
});
const weaponOptions = buildCascadeOptions({
  names: Object.keys(rulebook.weapons),
  metadata: weaponMetadata,
  noSelection: '不选择武器',
  groupOf: (item) => item.weaponText,
  groupOrder: ['单手剑', '双手剑', '长柄武器', '法器', '弓'],
});
const targetLevelOptions = buildTargetLevelOptions();
const levelRangeOptions = buildLevelRangeOptions();

setCascadeOptions(settings, 'selectedCharacter', characterOptions);
setCascadeOptions(settings, 'selectedWeapon', weaponOptions);
setCascadeOptions(settings, 'autoCharacterTargetLevel', targetLevelOptions, '90级');
setCascadeOptions(settings, 'autoWeaponTargetLevel', targetLevelOptions, '90级');
setCascadeOptions(settings, 'characterLevelRange', levelRangeOptions, '80级（突破前）>90级');
setCascadeOptions(settings, 'weaponLevelRange', levelRangeOptions, '80级（突破前）>90级');
await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
console.log(`已更新目标下拉列表：${Object.keys(rulebook.characters).length} 名角色，${Object.keys(rulebook.weapons).length} 把武器`);

function buildCascadeOptions({ names, metadata, noSelection, groupOf, groupOrder }) {
  const groups = new Map(groupOrder.map((group) => [group, []]));
  for (const name of names) {
    const item = metadata.get(name);
    if (!item) throw new Error(`genshin-db 缺少目标元数据：${name}`);
    const group = groupOf(item);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(name);
  }
  const result = { '不使用下拉选择': [noSelection] };
  for (const [group, values] of groups) {
    if (values.length === 0) continue;
    result[group] = values.sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }
  return result;
}

function buildTargetLevelOptions() {
  return Object.fromEntries([90, 80, 70, 60, 50, 40, 20].map((level) => [
    `${level}级目标`,
    [level === 90 ? '90级' : formatLevel(level, true)],
  ]));
}

function buildLevelRangeOptions() {
  const currentStates = [
    { level: 1, ascended: false },
    ...[20, 40, 50, 60, 70, 80].flatMap((level) => [
      { level, ascended: false }, { level, ascended: true },
    ]),
  ];
  const targetStates = [
    { level: 90, ascended: false },
    ...[80, 70, 60, 50, 40, 20].map((level) => ({ level, ascended: true })),
  ];
  return Object.fromEntries(targetStates.map((target) => [
    `升至${formatLevel(target.level, target.ascended)}`,
    currentStates
      .filter((current) => current.level < target.level
        || (current.level === target.level && !current.ascended && target.ascended))
      .map((current) => `${formatLevel(current.level, current.ascended)}>${formatLevel(target.level, target.ascended)}`),
  ]));
}

function formatLevel(level, ascended) {
  return [20, 40, 50, 60, 70, 80].includes(level)
    ? `${level}级（突破${ascended ? '后' : '前'}）`
    : `${level}级`;
}

function setCascadeOptions(settingItems, name, cascadeOptions, defaultValue = undefined) {
  const item = settingItems.find((setting) => setting.name === name);
  if (!item) throw new Error(`settings.json 缺少设置项：${name}`);
  item.cascadeOptions = cascadeOptions;
  if (defaultValue !== undefined) item.default = defaultValue;
}
