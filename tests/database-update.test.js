import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlan } from '../core/planner.js';
import { discoverAutoPathingRoutes } from '../core/routes.js';

const readData = (name) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8'));
const rulebook = readData('rulebook.json');
const materials = readData('materials.json');
const recipes = readData('crafting-recipes.json');
const sourceCandidates = readData('source-candidates.json');
const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const inventory = Object.fromEntries(Object.keys(materials).map((id) => [id, 0]));

for (const [name, day, bossMaterial, bookMaterial] of [
  ['沃雅妮莎', 2, '113090', '104368'],
  ['薇斯纳', 3, '113092', '104371'],
]) {
  test(`${name}：正式数据可计算，天赋秘境可安排，未适配 Boss 保持手动`, () => {
    const options = settings.find((item) => item.name === 'selectedCharacter').cascadeOptions;
    assert.ok(Object.values(options).some((group) => group.includes(name)));

    const plan = createPlan({
      targets: [{
        kind: 'character', name,
        level: { current: 1, target: 90 },
        talents: { skill: { current: 1, target: 8 } },
      }],
      inventory, materials, recipes, rulebook, today: day,
    });

    assert.equal(plan.requirements[bossMaterial], 46);
    assert.ok(plan.requirements[bookMaterial] > 0);
    assert.ok(plan.todayQueue.some((item) => item.domainName === '荒坠的圣迹'));
    assert.ok(plan.manualItems.some((item) => item.materialId === bossMaterial));
    assert.ok(!plan.todayQueue.some((item) => item.executionType === 'boss'));
  });
}

test('两名新角色的怪物材料可从已订阅路线目录匹配', () => {
  const folders = new Set([
    '敌人与魔物/异种合成魔兽', '敌人与魔物/异种合成魔兽/作者',
    '敌人与魔物/肌生晶石的妖精', '敌人与魔物/肌生晶石的妖精/作者',
  ]);
  const files = new Set([
    '敌人与魔物/异种合成魔兽/作者/01.json',
    '敌人与魔物/肌生晶石的妖精/作者/01.json',
  ]);
  const result = discoverAutoPathingRoutes({
    shortages: [
      { materialId: '112149', shortage: 3 },
      { materialId: '112146', shortage: 3 },
    ],
    sourceCandidates,
    pathing: {
      readPaths: (path) => path.endsWith('/作者') ? [`${path}/01.json`]
        : folders.has(path) ? [`${path}/作者`] : [],
      isFolder: (path) => folders.has(path),
      isFile: (path) => files.has(path),
    },
  });
  assert.equal(result.matched.length, 2);
  assert.equal(result.missing.length, 0);
});

test('两名新角色的地方特产可从已订阅路线目录匹配', () => {
  const folders = new Set([
    '地方特产', '地方特产/至冬',
    '地方特产/至冬/霜仙花', '地方特产/至冬/金蕨',
  ]);
  const files = new Set([
    '地方特产/至冬/霜仙花/01.json', '地方特产/至冬/金蕨/01.json',
  ]);
  const result = discoverAutoPathingRoutes({
    shortages: [
      { materialId: '101275', shortage: 3, material: materials['101275'] },
      { materialId: '101277', shortage: 3, material: materials['101277'] },
    ],
    sourceCandidates,
    pathing: {
      readPaths: (path) => path === '地方特产' ? ['地方特产/至冬']
        : path === '地方特产/至冬' ? ['地方特产/至冬/霜仙花', '地方特产/至冬/金蕨']
          : files.has(`${path}/01.json`) ? [`${path}/01.json`] : [],
      isFolder: (path) => folders.has(path),
      isFile: (path) => files.has(path),
    },
  });
  assert.equal(result.matched.length, 2);
  assert.equal(result.missing.length, 0);
});
