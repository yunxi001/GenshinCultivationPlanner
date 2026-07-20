import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlan } from '../core/planner.js';
import { applyInventoryScanResult, buildInventoryScanGroups, getInventoryTab } from '../core/inventory.js';
import { discoverAutoPathingRoutes } from '../core/routes.js';
import { buildRunSummary } from '../core/report.js';
import { collectExecutionWarnings } from '../core/preflight.js';
import { buildDomainResinPolicy } from '../core/resin.js';
import { buildDomainExecutionConfig } from '../core/domain-executor.js';
import { buildPlan, buildWeeklyStrategy, hasPendingOriginalResinTask } from '../core/scheduler.js';
import { buildTrackedInventoryGains } from '../core/execution-progress.js';
import { appendRunHistory, buildRunRecord } from '../core/history.js';
import { inferSundaySelectedValue } from '../core/sunday-selection.js';
import { parseTargetText } from '../core/target-input.js';
import { resolvePlanningWeekday } from '../core/server-weekday.js';
import { buildCompletionEstimate } from '../core/estimate.js';
import { validateDomainExecutionMap } from '../core/domain-catalog.js';
import { buildRouteExecutionPlan } from '../core/route-executor.js';
import { buildWeeklyBossExecutionConfig } from '../core/weekly-executor.js';
import { buildBossExecutionConfig } from '../core/boss-executor.js';
import { appendArtifactFallbackTask, buildArtifactDomainExecutionConfig } from '../core/artifact-executor.js';
import { switchPartyWithRecovery } from '../core/party-switch.js';

const materials = {
  talentBook: {
    status: 'supported',
    executionType: 'domain',
    openDays: [1, 4, 0],
    limited: true,
    priority: 10,
  },
  bossDrop: {
    status: 'supported',
    executionType: 'boss',
    limited: false,
    priority: 5,
  },
  localSpecialty: {
    status: 'manual',
    executionType: 'route',
  },
  mora: {
    status: 'excluded',
    executionType: 'none',
  },
};

const rulebook = {
  characters: {
    测试角色: {
      ascensionCosts: {
        ascend5: [{ id: 1001, count: 12 }],
        ascend6: [{ id: 1001, count: 20 }],
      },
      talentCosts: {
        lvl7: [{ id: 1002, count: 4 }],
        lvl8: [{ id: 1002, count: 6 }],
      },
    },
  },
  weapons: {
    测试武器: {
      ascensionCosts: {
        ascend5: [{ id: 1003, count: 9 }],
        ascend6: [{ id: 1003, count: 6 }],
      },
    },
  },
};

const recipes = {
  high: { resultCount: 1, inputs: [{ id: 'mid', count: 3 }] },
  mid: { resultCount: 1, inputs: [{ id: 'low', count: 3 }] },
};

test('合并多目标需求并计算库存缺口', () => {
  const plan = createPlan({
    targets: [
      { id: 'character-a', requirements: [{ materialId: 'talentBook', count: 9 }, { materialId: 'bossDrop', count: 2 }] },
      { id: 'weapon-a', requirements: [{ materialId: 'talentBook', count: 3 }, { materialId: 'mora', count: 100000 }] },
    ],
    inventory: { talentBook: 4, bossDrop: 2, mora: 0 },
    materials,
    rulebook,
    today: 1,
  });

  assert.equal(plan.requirements.talentBook, 12);
  assert.equal(plan.shortages.find((item) => item.materialId === 'talentBook').shortage, 8);
  assert.equal(plan.shortages.find((item) => item.materialId === 'bossDrop').status, 'complete');
  assert.equal(plan.todayQueue[0].materialId, 'talentBook');
  assert.equal(plan.manualItems[0].materialId, 'mora');
});

test('当天未开放的限时材料不会进入当天队列，但会出现在开放日计划', () => {
  const plan = createPlan({
    targets: [{ id: 'character-a', requirements: [{ materialId: 'talentBook', count: 1 }] }],
    inventory: { talentBook: 0 },
    materials,
    rulebook,
    today: 2,
  });

  assert.equal(plan.todayQueue.length, 0);
  assert.equal(plan.weeklyPlan[4][0].materialId, 'talentBook');
});

test('周循环策略从今天起按七天顺序展示已安排秘境', () => {
  const plan = createPlan({
    targets: [{ id: 'test', requirements: [{ materialId: 'talentBook', count: 2 }] }],
    inventory: { talentBook: 0 }, materials, rulebook, today: 1,
  });
  const strategy = buildWeeklyStrategy(plan.weeklyPlan, 1);
  assert.deepEqual(strategy.map((item) => item.label), ['今天（周一）', '周四', '周日']);
  assert.equal(strategy[0].tasks[0].materialId, 'talentBook');
});

test('未确认库存不会被误判为零库存或可执行任务', () => {
  const plan = createPlan({
    targets: [{ id: 'character-a', requirements: [{ materialId: 'localSpecialty', count: 10 }] }],
    inventory: {},
    materials,
    rulebook,
    today: 1,
  });

  assert.equal(plan.shortages[0].status, 'unknown');
  assert.equal(plan.todayQueue.length, 0);
  assert.equal(plan.manualItems[0].reason, '尚未确认背包库存');
});

test('角色与武器目标会按等级和天赋区间展开为材料需求', () => {
  const plan = createPlan({
    targets: [
      {
        kind: 'character',
        name: '测试角色',
        level: { current: 70, target: 90 },
        talents: { normal: { current: 6, target: 8 } },
      },
      { kind: 'weapon', name: '测试武器', level: { current: 70, target: 90 } },
    ],
    inventory: { 1001: 0, 1002: 0, 1003: 0 },
    materials: {
      1001: { status: 'manual' },
      1002: { status: 'manual' },
      1003: { status: 'manual' },
    },
    rulebook,
    today: 1,
  });

  assert.equal(plan.requirements[1001], 20);
  assert.equal(plan.requirements[1002], 10);
  assert.equal(plan.requirements[1003], 6);
});

test('设置页目标文本兼容中文英文标点并区分角色和武器', () => {
  const targets = parseTargetText('测试角色：７０＞９０，６／８／８→９／９／９；测试武器:70>90', rulebook);
  assert.deepEqual(targets, [
    {
      kind: 'character', name: '测试角色', level: { current: 70, target: 90 },
      talents: {
        normal: { current: 6, target: 9 }, skill: { current: 8, target: 9 }, burst: { current: 8, target: 9 },
      },
    },
    { kind: 'weapon', name: '测试武器', level: { current: 70, target: 90 } },
  ]);
});

test('设置页目标文本会拒绝未知名称、重复项、倒退等级和错误武器天赋', () => {
  assert.throws(() => parseTargetText('不存在:70>90', rulebook), /不在当前规则库/);
  assert.throws(() => parseTargetText('测试角色:80>70', rulebook), /不能倒退/);
  assert.throws(() => parseTargetText('测试角色:70>90;测试角色:70>90', rulebook), /重复/);
  assert.throws(() => parseTargetText('测试武器:70>90,1/1/1>2/2/2', rulebook), /不能填写天赋/);
});

test('计划星期按服务器时间并以凌晨四点作为刷新边界', () => {
  const offset = 8 * 60 * 60 * 1000;
  assert.equal(resolvePlanningWeekday({
    nowMs: Date.UTC(2026, 6, 19, 19, 59), serverOffsetMs: offset,
  }), 0);
  assert.equal(resolvePlanningWeekday({
    nowMs: Date.UTC(2026, 6, 19, 20, 0), serverOffsetMs: offset,
  }), 1);
  assert.equal(resolvePlanningWeekday({ automatic: false, manualWeekday: '6' }), 6);
  assert.throws(() => resolvePlanningWeekday({ automatic: false, manualWeekday: '9' }), /0 到 6/);
});

test('会先使用低阶库存合成，再只计算真正需要刷取的材料', () => {
  const plan = createPlan({
    targets: [{ id: 'test', requirements: [{ materialId: 'high', count: 2 }] }],
    inventory: { high: 0, mid: 3, low: 3 },
    materials: {
      high: { name: '高阶材料', status: 'manual' },
      mid: { name: '中阶材料', status: 'manual' },
      low: { name: '低阶材料', status: 'manual' },
    },
    recipes,
    rulebook,
    today: 1,
  });

  assert.equal(plan.crafting.craftPlan[0].materialId, 'high');
  assert.equal(plan.crafting.craftPlan[0].craftCount, 2);
  assert.equal(plan.crafting.craftPlan[1].materialId, 'mid');
  assert.equal(plan.crafting.craftPlan[1].craftCount, 3);
  assert.equal(plan.shortages.find((item) => item.materialId === 'low').shortage, 6);
});

test('库存可使用材料中文名输入并转换为规则库 ID', () => {
  const plan = createPlan({
    targets: [{ id: 'test', requirements: [{ materialId: '1001', count: 5 }] }],
    inventory: { 测试材料: 3 },
    materials: { 1001: { name: '测试材料', status: 'manual' } },
    rulebook,
    today: 1,
  });

  assert.equal(plan.shortages[0].owned, 3);
  assert.equal(plan.shortages[0].shortage, 2);
});

test('范围外材料即使未读取库存也不会被标记为库存未知', () => {
  const plan = createPlan({
    targets: [{ id: 'test', requirements: [{ materialId: 'mora', count: 1000 }] }],
    inventory: {},
    materials,
    rulebook,
    today: 1,
  });

  assert.equal(plan.shortages[0].status, 'excluded');
  assert.equal(plan.shortages[0].reason, '不在自动刷取范围内');
});

test('背包读取按页分组，未返回按零计而 OCR 失败保留未确认', () => {
  const scanMaterials = {
    104301: { name: '天赋书', status: 'manual' },
    112001: { name: '怪物材料', status: 'manual' },
    202: { name: '摩拉', status: 'excluded' },
  };
  const groups = buildInventoryScanGroups(['104301', '112001', '202'], scanMaterials);
  assert.equal(getInventoryTab('112001'), 'CharacterDevelopmentItems');
  assert.equal(getInventoryTab('100031'), 'Materials');
  assert.deepEqual(groups.CharacterDevelopmentItems, [
    { materialId: '104301', name: '天赋书' },
    { materialId: '112001', name: '怪物材料' },
  ]);
  assert.equal(groups.Materials, undefined);

  const applied = applyInventoryScanResult({}, [{ materialId: '104301', name: '天赋书' }], { 天赋书: -1 });
  assert.equal(applied.inventory['104301'], 0);
  assert.deepEqual(applied.failedNames, []);
  const omitted = applyInventoryScanResult({}, [{ materialId: '112001', name: '怪物材料' }], {});
  assert.equal(omitted.inventory['112001'], 0);
  assert.deepEqual(omitted.failedNames, []);
  const failed = applyInventoryScanResult({}, [{ materialId: '112001', name: '怪物材料' }], { 怪物材料: -2 });
  assert.equal(failed.inventory['112001'], undefined);
  assert.deepEqual(failed.failedNames, ['怪物材料']);
});

test('自动发现：地方特产跨国别目录，怪物支持“愚人众·”目录别名', () => {
  const folders = new Set([
    '地方特产',
    '地方特产/璃月',
    '地方特产/璃月/清心',
    '敌人与魔物/债务处理人',
  ]);
  const files = new Set([
    '地方特产/璃月/清心/01-清心.json',
    '敌人与魔物/债务处理人/债务处理人-1.json',
  ]);
  const children = {
    '地方特产': ['地方特产/璃月'],
    '地方特产/璃月': ['地方特产/璃月/清心'],
    '地方特产/璃月/清心': ['地方特产/璃月/清心/01-清心.json'],
    '敌人与魔物/债务处理人': ['敌人与魔物/债务处理人/债务处理人-1.json'],
  };
  const result = discoverAutoPathingRoutes({
    shortages: [
      { materialId: '100031', shortage: 2 },
      { materialId: '112031', shortage: 3 },
    ],
    sourceCandidates: {
      '100031': { name: '清心', type: 'localSpecialty', routeNames: ['清心'] },
      '112031': { name: '督察长祭刀', type: 'monster', routeNames: ['愚人众·债务处理人', '债务处理人'] },
    },
    pathing: {
      readPaths: (path) => children[path] ?? [],
      isFolder: (path) => folders.has(path),
      isFile: (path) => files.has(path),
    },
  });
  assert.equal(result.matched.length, 2);
  assert.equal(result.missing.length, 0);
  assert.equal(result.matched[0].paths[0], '地方特产/璃月/清心/01-清心.json');
  assert.equal(result.matched[1].paths[0], '敌人与魔物/债务处理人/债务处理人-1.json');
});

test('运行摘要明确计划模式、候选任务和无历史数据时的预计完成状态', () => {
  const summary = buildRunSummary({
    todayQueue: [{ materialId: 'book', shortage: 12 }],
    shortages: [{ materialId: 'book', shortage: 12 }],
  }, { book: { name: '测试天赋书' } });
  assert.match(summary, /仅生成计划，未刷取/);
  assert.match(summary, /测试天赋书\(12\)/);
  assert.match(summary, /等待累计实际掉落数据/);
  assert.match(summary, /<br><b>仍缺材料<\/b>/);
});

test('完成预估只使用已确认背包差值，并按开放日推算所需天数', () => {
  const estimateMaterials = {
    book: { name: '测试书', status: 'supported', executionType: 'domain', domainName: '测试秘境', openDays: [1, 4, 0] },
  };
  const estimate = buildCompletionEstimate({
    plan: { displayShortages: [{ materialId: 'book', shortage: 5 }] },
    materials: estimateMaterials,
    today: 1,
    history: [
      { execution: { status: 'completed', appliedGains: true, task: { domainName: '测试秘境' }, trackedRewards: { 测试书: 2 } } },
      { execution: { status: 'completed', appliedGains: true, task: { domainName: '测试秘境' }, trackedRewards: { 测试书: 3 } } },
      { execution: { status: 'completed', appliedGains: false, task: { domainName: '测试秘境' }, trackedRewards: {} } },
    ],
  });
  assert.equal(estimate.days, 3);
  assert.equal(estimate.details[0].estimatedRuns, 2);
  assert.match(estimate.reason, /历史均值/);
});

test('多阶材料按等价值计算后，实际缺口按高到低阶分别展示', () => {
  const plan = createPlan({
    targets: [{ id: 'test', requirements: [{ materialId: 'high', count: 3 }] }],
    inventory: { high: 1, mid: 1, low: 2 },
    materials: {
      high: { name: '哲学', status: 'supported', executionType: 'domain' },
      mid: { name: '指引', status: 'supported', executionType: 'domain' },
      low: { name: '教导', status: 'supported', executionType: 'domain' },
    },
    recipes: {
      high: { resultCount: 1, inputs: [{ id: 'mid', name: '指引', count: 3 }] },
      mid: { resultCount: 1, inputs: [{ id: 'low', name: '教导', count: 3 }] },
    },
    rulebook,
    today: 1,
  });
  assert.deepEqual(
    plan.displayShortages.map((item) => [item.materialId, item.shortage]),
    [['high', 1], ['low', 1], ['mid', 1]],
  );
});

test('同一秘境的多阶材料合并为一次候选任务', () => {
  const plan = createPlan({
    targets: [{ id: 'test', requirements: [{ materialId: 'high', count: 3 }] }],
    inventory: { high: 1, mid: 1, low: 2 },
    materials: {
      high: { name: '哲学', status: 'supported', executionType: 'domain', domainName: '测试秘境', openDays: [1] },
      mid: { name: '指引', status: 'supported', executionType: 'domain', domainName: '测试秘境', openDays: [1] },
      low: { name: '教导', status: 'supported', executionType: 'domain', domainName: '测试秘境', openDays: [1] },
    },
    recipes: {
      high: { resultCount: 1, inputs: [{ id: 'mid', name: '指引', count: 3 }] },
      mid: { resultCount: 1, inputs: [{ id: 'low', name: '教导', count: 3 }] },
    },
    rulebook,
    today: 1,
  });
  assert.equal(plan.todayQueue.length, 1);
  assert.equal(plan.todayQueue[0].domainName, '测试秘境');
  assert.deepEqual(plan.todayQueue[0].materials.map((item) => item.materialId).sort(), ['high', 'low', 'mid']);
});

test('执行前检查会提示缺少候选任务对应的队伍配置', () => {
  const warnings = collectExecutionWarnings({
    todayQueue: [{ executionType: 'domain' }],
    routes: { matched: [{ type: 'localSpecialty' }] },
  }, {});
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /秘境队伍/);
  assert.match(warnings[1], /采集队伍/);
});

test('秘境树脂策略默认先使用浓缩树脂，再使用原粹树脂', () => {
  const policy = buildDomainResinPolicy({});
  assert.deepEqual(policy.priority, ['浓缩树脂', '原粹树脂']);
  assert.equal(policy.originalResinUseCount, 9999);
  assert.equal(policy.condensedResinUseCount, 9999);
  assert.equal(policy.fragileResinUseCount, 0);
});

test('执行收益以背包前后差值为准，不把未确认库存当作零', () => {
  const gains = buildTrackedInventoryGains(
    { high: 1, mid: undefined, low: 2 },
    { high: 4, mid: 5, low: 2 },
    ['high', 'mid', 'low'],
    { high: { name: '哲学' }, mid: { name: '指引' }, low: { name: '教导' } },
  );
  assert.deepEqual(gains, { 哲学: 3 });
});

test('运行记录保存执行结果、库存前后值和剩余缺口，并限制历史数量', () => {
  const record = buildRunRecord({
    executionEnabled: true,
    plan: { displayShortages: [{ materialId: 'book', shortage: 3 }, { materialId: 'done', shortage: 0 }] },
    inventoryBefore: { book: 1 },
    inventoryAfter: { book: 3 },
    execution: { status: 'completed', trackedRewards: { 测试天赋书: 2 } },
    domainResinPolicy: { condensedResinUseCount: 1 },
  });
  assert.equal(record.execution.trackedRewards.测试天赋书, 2);
  assert.deepEqual(record.remainingShortages, [{ materialId: 'book', shortage: 3 }]);
  const history = appendRunHistory(Array.from({ length: 100 }, (_, index) => ({ index })), record);
  assert.equal(history.length, 100);
  assert.equal(history.at(-1), record);
});

test('存在可执行周本或世界 Boss 时，秘境不得抢占执行顺序', () => {
  assert.equal(hasPendingOriginalResinTask([{ executionType: 'weeklyBoss', status: 'supported' }]), true);
  assert.equal(hasPendingOriginalResinTask([{ executionType: 'boss', status: 'supported' }]), true);
  assert.equal(hasPendingOriginalResinTask([{ executionType: 'boss', status: 'manual' }, { executionType: 'domain', status: 'supported' }]), false);
});

test('周日秘境奖励序号按材料开放日自动推导', () => {
  assert.equal(inferSundaySelectedValue([1, 4, 0]), '1');
  assert.equal(inferSundaySelectedValue([2, 5, 0]), '2');
  assert.equal(inferSundaySelectedValue([3, 6, 0]), '3');
  assert.equal(inferSundaySelectedValue([0]), '');
});

test('来源映射只能使用 BetterGI 培养材料秘境目录中的名称', () => {
  assert.doesNotThrow(() => validateDomainExecutionMap(
    { domains: { '精通秘境：测试': { domainName: '太山府' } } },
    { materialDomains: ['太山府'] },
  ));
  assert.throws(() => validateDomainExecutionMap(
    { domains: { '精通秘境：测试': { domainName: '不存在的秘境' } } },
    { materialDomains: ['太山府'] },
  ), /未知秘境/);
});

test('路线执行默认关闭，开启后要求对应队伍与有效路径', () => {
  const routes = { matched: [{ materialId: 'localSpecialty', name: '测试特产', type: 'localSpecialty', paths: ['地方特产/测试/测试特产/a.json'] }] };
  assert.deepEqual(buildRouteExecutionPlan(routes, {}), []);
  assert.throws(() => buildRouteExecutionPlan(routes, { routeExecutionEnabled: true }), /采集队伍/);
  const plan = buildRouteExecutionPlan(routes, { routeExecutionEnabled: true, gatheringTeamName: '采集队' });
  assert.equal(plan[0].partyName, '采集队');
});

test('周本执行只使用原粹树脂并支持复用 Boss 队伍', () => {
  const config = buildWeeklyBossExecutionConfig(
    { executionType: 'weeklyBoss', domainName: '深入风龙废墟', materialId: '113005', materialName: '东风的吐息', shortage: 2 },
    { bossTeamName: '周本队' },
  );
  assert.equal(config.partyName, '周本队');
  assert.equal(config.originalResinUseCount, 9999);
  assert.throws(() => buildWeeklyBossExecutionConfig(
    { executionType: 'weeklyBoss', domainName: '深入风龙废墟' }, {},
  ), /未配置周本队伍/);
});

test('同一周本的多个掉落材料合并为一次征讨领域任务', () => {
  const shortages = [
    {
      materialId: 'weekly-1', shortage: 3,
      material: { name: '东风的吐息', executionType: 'weeklyBoss', domainName: '深入风龙废墟', openDays: [0], status: 'supported', priority: 200 },
    },
    {
      materialId: 'weekly-2', shortage: 2,
      material: { name: '东风之爪', executionType: 'weeklyBoss', domainName: '深入风龙废墟', openDays: [0], status: 'supported', priority: 200 },
    },
  ];
  const plan = buildPlan(shortages, 0);
  assert.equal(plan.todayQueue.length, 1);
  assert.equal(plan.todayQueue[0].executionType, 'weeklyBoss');
  assert.equal(plan.todayQueue[0].materials.length, 2);
});

test('世界 Boss 执行器只允许原粹树脂并要求独立队伍', () => {
  const config = buildBossExecutionConfig({
    executionType: 'boss', bossName: '急冻树', materialId: '113010', materialName: '极寒之核', shortage: 4,
  }, { bossTeamName: 'Boss 队伍', bossCombatStrategyName: '急冻树策略' });
  assert.equal(config.bossName, '急冻树');
  assert.equal(config.partyName, 'Boss 队伍');
  assert.equal(config.runCount, 9999);
  assert.equal(config.specifyRunCount, false);
  const singleRunConfig = buildBossExecutionConfig({
    executionType: 'boss', bossName: '急冻树', materialId: '113010', materialName: '极寒之核', shortage: 4,
  }, { bossTeamName: 'Boss 队伍', bossTestSingleRun: true });
  assert.equal(singleRunConfig.specifyRunCount, true);
  assert.equal(singleRunConfig.runCount, 1);
  assert.throws(() => buildBossExecutionConfig({ executionType: 'boss', bossName: '急冻树' }, {}), /未配置 Boss 队伍/);
});

test('运行摘要显示世界 Boss 名称，不显示未定义的秘境名称', () => {
  const summary = buildRunSummary({
    todayQueue: [{ executionType: 'boss', bossName: '无相之雷', materials: [{ materialName: '雷光棱镜', shortage: 5 }] }],
    displayShortages: [], weeklyStrategy: [],
  }, {}, {});
  assert.match(summary, /无相之雷：雷光棱镜×5/);
  assert.doesNotMatch(summary, /undefined/);
});

test('运行摘要会明确显示实际执行失败原因', () => {
  const summary = buildRunSummary({ todayQueue: [], displayShortages: [], weeklyStrategy: [] }, {}, {
    executionEnabled: true,
    execution: { status: 'failed', reason: '切换 Boss 队伍失败：四神队' },
  });
  assert.match(summary, /执行失败：切换 Boss 队伍失败：四神队/);
  assert.doesNotMatch(summary, /已执行完成/);
});

test('首次切队先传送神像，后续失败时才传送并重试', async () => {
  const calls = [];
  const state = { initialized: false };
  const logger = { info: () => calls.push('info'), warn: () => calls.push('warn') };
  const result = await switchPartyWithRecovery({
    partyName: '测试队', taskLabel: 'Boss', state, logger,
    teleportToStatue: async () => calls.push('statue'),
    switchParty: async () => { calls.push('switch'); return true; },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, ['info', 'statue', 'switch']);

  const retryCalls = [];
  let attempts = 0;
  const retryResult = await switchPartyWithRecovery({
    partyName: '测试队', taskLabel: 'Boss', state, logger: { info: () => {}, warn: () => retryCalls.push('warn') },
    teleportToStatue: async () => retryCalls.push('statue'),
    switchParty: async () => { attempts += 1; retryCalls.push('switch'); return attempts === 2; },
  });
  assert.equal(retryResult, true);
  assert.deepEqual(retryCalls, ['switch', 'warn', 'statue', 'switch']);
});

test('执行前检查会明确提示默认关闭的周本和 Boss 自动执行', () => {
  const warnings = collectExecutionWarnings({
    todayQueue: [
      { executionType: 'weeklyBoss', status: 'supported' },
      { executionType: 'boss', status: 'supported' },
    ],
  }, {});
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /周本自动执行默认关闭/);
  assert.match(warnings[1], /Boss 自动执行默认关闭/);
});

test('同一世界 Boss 的多个材料合并为一次首领任务', () => {
  const plan = buildPlan([
    { materialId: 'boss-1', shortage: 3, material: { name: '材料甲', executionType: 'boss', bossName: '急冻树', openDays: [0], status: 'supported' } },
    { materialId: 'boss-2', shortage: 2, material: { name: '材料乙', executionType: 'boss', bossName: '急冻树', openDays: [0], status: 'supported' } },
  ], 0);
  assert.equal(plan.todayQueue.length, 1);
  assert.equal(plan.todayQueue[0].bossName, '急冻树');
  assert.equal(plan.todayQueue[0].materials.length, 2);
});

test('圣遗物秘境仅在当天没有培养树脂任务时作为可选填充', () => {
  const plan = { todayQueue: [] };
  appendArtifactFallbackTask(plan, { artifactDomainEnabled: true, artifactDomainName: '芬德尼尔之顶' });
  assert.equal(plan.todayQueue[0].executionType, 'artifactDomain');
  const withMaterial = { todayQueue: [{ executionType: 'domain', status: 'supported' }] };
  appendArtifactFallbackTask(withMaterial, { artifactDomainEnabled: true, artifactDomainName: '芬德尼尔之顶' });
  assert.equal(withMaterial.todayQueue.length, 1);
  const config = buildArtifactDomainExecutionConfig(plan.todayQueue[0], { artifactDomainEnabled: true, artifactTeamName: '圣遗物队伍' }, buildDomainResinPolicy({}));
  assert.equal(config.domainName, '芬德尼尔之顶');
  assert.equal(config.autoArtifactSalvage, false);
});

test('秘境执行配置必须具备队伍、映射任务和允许树脂', () => {
  const config = buildDomainExecutionConfig(
    { executionType: 'domain', domainName: '太山府', materials: [] },
    { domainTeamName: '秘境队' },
    buildDomainResinPolicy({}),
  );
  assert.equal(config.domainName, '太山府');
  assert.equal(config.partyName, '秘境队');
  assert.throws(() => buildDomainExecutionConfig(
    { executionType: 'domain', domainName: '太山府' }, {}, buildDomainResinPolicy({}),
  ), /未配置秘境队伍/);
  assert.throws(() => buildDomainExecutionConfig(
    { executionType: 'domain', domainName: '太山府' },
    { domainTeamName: '秘境队', weekday: '0' }, buildDomainResinPolicy({}),
  ), /未配置正确的奖励序号/);
  const sundayConfig = buildDomainExecutionConfig(
    { executionType: 'domain', domainName: '太山府', sundaySelectedValue: '2' },
    { domainTeamName: '秘境队', weekday: '0' }, buildDomainResinPolicy({}),
  );
  assert.equal(sundayConfig.sundaySelectedValue, '2');
});
