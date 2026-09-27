import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlan } from '../core/planner.js';
import { applyInventoryScanResult, buildInventoryScanGroups, getInventoryTab } from '../core/inventory.js';
import { applyMatchedRouteSupport, discoverAutoPathingRoutes } from '../core/routes.js';
import {
  buildFailureRunSummary,
  buildPlanReadySummary,
  buildRunStartSummary,
  buildRunSummary,
  limitNotificationMessage,
  shouldSendRunNotifications,
} from '../core/report.js';
import { collectExecutionWarningOutcomes, collectExecutionWarnings } from '../core/preflight.js';
import { applyDomainResinPolicyToParam, buildDomainResinPolicy } from '../core/resin.js';
import { buildDomainExecutionConfig } from '../core/domain-executor.js';
import { buildPlan, buildWeeklyStrategy, hasPendingOriginalResinTask } from '../core/scheduler.js';
import { buildTrackedInventoryGains } from '../core/execution-progress.js';
import { appendRunHistory, buildRunRecord, findHistoricalInventoryConflicts } from '../core/history.js';
import { inferSundaySelectedValue } from '../core/sunday-selection.js';
import { parseTargetText } from '../core/target-input.js';
import { resolvePlanningWeekday } from '../core/server-weekday.js';
import { buildCompletionEstimate } from '../core/estimate.js';
import { validateDomainExecutionMap } from '../core/domain-catalog.js';
import { applyFinalRouteInventoryGains, buildRouteExecutionPlan, runSubscribedRouteFile } from '../core/route-executor.js';
import { buildBossExecutionConfig, isBossTaskEnabled } from '../core/boss-executor.js';
import { appendArtifactFallbackTask, buildArtifactDomainExecutionConfig } from '../core/artifact-executor.js';
import { switchPartyWithRecovery } from '../core/party-switch.js';
import { assertExecutionConfirmed, normalizeScriptSettings, validateBossOverrideNames } from '../core/settings.js';
import { createExecutionOutcome, createRunExecution } from '../core/execution-outcome.js';

test('所有树脂任务默认启用 BetterGI 奖励识别', () => {
  const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.equal((source.match(/RewardRecognitionEnabled = true;/g) ?? []).length, 3);
  assert.doesNotMatch(source, /RewardRecognitionEnabled = false;/);
  assert.match(source, /param\.IconRecognitionMode = ItemIconRecognitionMode\.Item;/);
});

test('BetterGI 0.64 自动秘境参数显式采用脚本配置的树脂优先级', () => {
  const values = [];
  const param = {
    OriginalResin20UseCount: 7,
    OriginalResin40UseCount: 8,
    ResinPriorityList: {
      Clear() { values.length = 0; },
      Add(value) { values.push(value); },
    },
  };
  const policy = {
    specifyResinUse: true,
    priority: ['原粹树脂', '须臾树脂'],
    originalResinUseCount: 2,
    condensedResinUseCount: 0,
    transientResinUseCount: 1,
    fragileResinUseCount: 0,
  };
  applyDomainResinPolicyToParam(param, policy);
  assert.deepEqual(values, ['原粹树脂', '须臾树脂']);
  assert.equal(param.SpecifyResinUse, true);
  assert.equal(param.OriginalResinUseCount, 2);
  assert.equal(param.OriginalResin20UseCount, 0);
  assert.equal(param.OriginalResin40UseCount, 0);
  assert.equal(param.TransientResinUseCount, 1);
  assert.throws(() => applyDomainResinPolicyToParam({}, policy), /BetterGI 0\.64\.0/);
});

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

test('角色与武器位于突破等级时会计入当前突破档', () => {
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

  assert.equal(plan.requirements[1001], 32);
  assert.equal(plan.requirements[1002], 10);
  assert.equal(plan.requirements[1003], 15);
});

test('设置页目标文本兼容中文英文标点并区分角色和武器', () => {
  const targets = parseTargetText('测试角色：７０＞９０，６／８／８→９／９／９；测试武器:70>90', rulebook);
  assert.deepEqual(targets, [
    {
      kind: 'character', name: '测试角色',
      level: { current: 70, target: 90, currentAscended: false, targetAscended: false },
      talents: {
        normal: { current: 6, target: 9 }, skill: { current: 8, target: 9 }, burst: { current: 8, target: 9 },
      },
    },
    {
      kind: 'weapon', name: '测试武器',
      level: { current: 70, target: 90, currentAscended: false, targetAscended: false },
    },
  ]);
});

test('设置页目标文本会拒绝未知名称、重复项、倒退等级和错误武器天赋', () => {
  assert.throws(() => parseTargetText('不存在:70>90', rulebook), /不在当前规则库/);
  assert.throws(() => parseTargetText('测试角色:80>70', rulebook), /不能倒退/);
  assert.throws(() => parseTargetText('测试角色:70>90;测试角色:70>90', rulebook), /重复/);
  assert.throws(() => parseTargetText('测试武器:70>90,1/1/1>2/2/2', rulebook), /不能填写天赋/);
});

test('运行方式映射到自动档案并迁移旧手动模式', () => {
  assert.equal(normalizeScriptSettings({ targetInputMode: '预览目标（不执行）' }).targetInputMode, '自动档案仅预览');
  assert.equal(normalizeScriptSettings({ targetInputMode: '读取档案并执行' }).targetInputMode, '自动档案识别后执行');
  const migrated = normalizeScriptSettings({
    targetInputMode: '手动填写当前与目标',
    customTargetsEnabled: true,
    targetsText: '测试角色:80>90',
  });
  assert.equal(migrated.targetInputMode, '自动档案识别后执行');
  assert.equal(migrated.targetsText, '');
  assert.throws(() => normalizeScriptSettings({ targetInputMode: '未知方式' }), /未知的运行方式/);
});

test('紧凑运行模式转换为现有执行器配置', () => {
  const normalized = normalizeScriptSettings({
    gatheringRouteExecutionEnabled: true,
    monsterRouteExecutionEnabled: false,
    domainRunMode: '单次测试',
    bossRunMode: '单次测试 Boss',
    artifactRunMode: '正式｜月童的库藏',
    resinStrategy: '仅原粹',
  });
  assert.equal(normalized.domainTestSingleRun, true);
  assert.equal(normalized.gatheringRouteExecutionEnabled, true);
  assert.equal(normalized.monsterRouteExecutionEnabled, false);
  assert.equal(normalized.routeExecutionEnabled, true);
  assert.equal(normalized.bossExecutionEnabled, true);
  assert.equal(normalized.bossTestSingleRun, true);
  assert.equal(normalized.artifactDomainEnabled, true);
  assert.equal(normalized.artifactTestSingleRun, false);
  assert.equal(normalized.artifactDomainName, '月童的库藏');
  assert.equal(normalized.domainUseCondensedResin, false);
  assert.equal(normalized.domainUseOriginalResin, true);
  assert.equal(normalized.domainUseTransientResin, false);
  assert.equal(normalized.domainUseFragileResin, false);
});

test('紧凑设置不存在时保留旧配置兼容行为', () => {
  const legacy = {
    bossExecutionEnabled: true,
    bossTestSingleRun: false,
    artifactDomainEnabled: true,
    artifactDomainName: '月童的库藏',
  };
  assert.deepEqual(normalizeScriptSettings(legacy), legacy);
  const legacyRoutes = normalizeScriptSettings({ routeExecutionEnabled: true });
  assert.equal(legacyRoutes.gatheringRouteExecutionEnabled, true);
  assert.equal(legacyRoutes.monsterRouteExecutionEnabled, true);
});

test('三类战斗策略使用独立字段，不再解析带任务类型的自由文本', () => {
  const normalized = normalizeScriptSettings({
    domainCombatStrategyName: '秘境策略',
    bossCombatStrategyName: '首领策略',
    artifactCombatStrategyName: '圣遗物策略',
  });
  assert.equal(normalized.domainCombatStrategyName, '秘境策略');
  assert.equal(normalized.bossCombatStrategyName, '首领策略');
  assert.equal(normalized.artifactCombatStrategyName, '圣遗物策略');
  assert.throws(() => normalizeScriptSettings({ bossRunMode: '随便刷' }), /未知的世界 Boss 模式/);
});

test('Boss 专属覆盖使用紧凑文本，并兼容旧版结构化槽', () => {
  const normalized = normalizeScriptSettings({
    bossOverridesEnabled: true,
    bossOverridesText: '急冻树:队伍=冰抗队,策略=急冻树策略；无相之水:禁用;爆炎树:队伍=火队',
  });
  assert.deepEqual(normalized.bossOverrides, {
    急冻树: { partyName: '冰抗队', strategyName: '急冻树策略' },
    无相之水: { enabled: false },
    爆炎树: { partyName: '火队' },
  });
  assert.deepEqual(normalizeScriptSettings({
    bossOverridesEnabled: false,
    bossOverridesText: '急冻树:队伍=错误队伍,策略=错误策略',
  }).bossOverrides, {});
  assert.throws(() => normalizeScriptSettings({
    bossOverridesEnabled: true, bossOverridesText: '急冻树:队伍=队伍；急冻树:队伍=另一队',
  }), /Boss 专属配置重复/);
  assert.throws(() => normalizeScriptSettings({
    bossOverridesEnabled: true, bossOverridesText: '急冻树=',
  }), /格式错误/);
  assert.throws(() => normalizeScriptSettings({
    bossOverridesEnabled: true, bossOverridesText: '急冻树=|',
  }), /没有填写/);
  assert.throws(() => normalizeScriptSettings({
    bossOverridesEnabled: true, bossOverridesText: '急冻树:队伍=一队,队伍=二队',
  }), /重复填写了队伍/);

  assert.deepEqual(normalizeScriptSettings({
    bossOverridesEnabled: true,
    bossOverridesText: '急冻树=冰抗队|急冻树策略',
  }).bossOverrides, {
    急冻树: { partyName: '冰抗队', strategyName: '急冻树策略' },
  });

  const legacy = normalizeScriptSettings({
    bossOverride1Name: '急冻树',
    bossOverride1Action: '继承通用配置',
    bossOverride1TeamName: '冰抗队',
    bossOverride1StrategyName: '急冻树策略',
    bossOverride2Name: '无相之水',
    bossOverride2Action: '禁用',
    bossOverride2TeamName: '',
    bossOverride2StrategyName: '',
    bossOverride3Name: '爆炎树',
    bossOverride3Action: '启用',
    bossOverride3TeamName: '',
    bossOverride3StrategyName: '',
  });
  assert.deepEqual(legacy.bossOverrides, {
    急冻树: { partyName: '冰抗队', strategyName: '急冻树策略' },
    无相之水: { enabled: false },
    爆炎树: { enabled: true },
  });
  assert.throws(() => normalizeScriptSettings({
    bossOverride1Name: '急冻树', bossOverride2Name: '急冻树',
  }), /Boss 专属配置重复/);
  assert.throws(() => normalizeScriptSettings({
    bossOverride1Name: '不配置专属 Boss', bossOverride1TeamName: '错误队伍',
  }), /没有选择 Boss/);
  assert.throws(() => normalizeScriptSettings({
    bossOverride1Name: '急冻树', bossOverride1Action: '随便处理',
  }), /处理方式无效/);

  const catalog = { bosses: ['急冻树', '无相之水', '爆炎树'] };
  assert.doesNotThrow(() => validateBossOverrideNames(normalized, catalog));
  assert.throws(() => validateBossOverrideNames({ bossOverrides: { '急冻樹': {} } }, catalog), /不是当前 BetterGI 支持/);
});

test('未确认实际执行风险时必须在任何任务开始前拒绝运行', () => {
  assert.throws(() => assertExecutionConfirmed({}), /请先勾选“我已确认配置并允许实际执行”/);
  assert.throws(() => assertExecutionConfirmed({ executionConfirmed: false }), /拒绝运行/);
  assert.doesNotThrow(() => assertExecutionConfirmed({ executionConfirmed: true }));
  assert.doesNotThrow(() => assertExecutionConfirmed({ executionConfirmed: 'true' }));
});

test('精简设置页的级联默认值有效且不再暴露旧开关', () => {
  const items = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
  const generatedRulebook = JSON.parse(readFileSync(new URL('../data/rulebook.json', import.meta.url), 'utf8'));
  const bossCatalog = JSON.parse(readFileSync(new URL('../data/bettergi-boss-catalog.json', import.meta.url), 'utf8'));
  const editableItems = items.filter((item) => item.type !== 'separator');
  const legacyNames = new Set([
    'planOnly', 'weeklyRunMode', 'weeklyBossTeamName',
    'domainTestSingleRun', 'bossExecutionEnabled', 'bossTestSingleRun',
    'weeklyBossExecutionEnabled', 'artifactDomainEnabled', 'artifactDomainName',
    'artifactTestSingleRun', 'domainUseCondensedResin', 'domainUseOriginalResin',
    'domainUseTransientResin', 'domainUseFragileResin',
    'combatStrategiesText',
    'bossOverride1Name', 'bossOverride1Action', 'bossOverride1TeamName', 'bossOverride1StrategyName',
    'bossOverride2Name', 'bossOverride2Action', 'bossOverride2TeamName', 'bossOverride2StrategyName',
    'bossOverride3Name', 'bossOverride3Action', 'bossOverride3TeamName', 'bossOverride3StrategyName',
  ]);
  assert.equal(editableItems.length, 37);
  assert.equal(items.find((item) => item.name === 'allowUnowned')?.default, false);
  assert.equal(editableItems.some((item) => legacyNames.has(item.name)), false);
  for (const item of items.filter((candidate) => candidate.type === 'cascade-select')) {
    const values = Object.values(item.cascadeOptions).flat();
    assert.equal(values.includes(item.default), true, `${item.name} 的默认值必须存在于二级选项中`);
    assert.equal(new Set(values).size, values.length, `${item.name} 的二级选项不能重复`);
  }
  for (const item of items.filter((candidate) => candidate.type === 'select')) {
    assert.equal(item.options.includes(item.default), true, `${item.name} 的默认值必须存在于选项中`);
  }
  const characterNames = Object.values(items.find((item) => item.name === 'selectedCharacter').cascadeOptions)
    .flat().filter((name) => name !== '不选择角色');
  const weaponNames = Object.values(items.find((item) => item.name === 'selectedWeapon').cascadeOptions)
    .flat().filter((name) => name !== '不选择武器');
  assert.deepEqual(new Set(characterNames), new Set(Object.keys(generatedRulebook.characters)));
  assert.deepEqual(new Set(weaponNames), new Set(Object.keys(generatedRulebook.weapons)));
  const names = items.map((item) => item.name);
  assert.ok(names.indexOf('selectedCharacter') < names.indexOf('domainRunMode'));
  assert.ok(names.indexOf('executionConfirmed') < names.indexOf('domainRunMode'));
  assert.equal(items.find((item) => item.name === 'executionConfirmed').default, false);
  assert.equal(names.indexOf('executionConfirmed'), 1);
  assert.equal(names.indexOf('targetInputMode'), 2);
  assert.equal(items.find((item) => item.name === 'targetInputMode').default, '读取档案并执行');
  assert.deepEqual(items.find((item) => item.name === 'autoWeaponMode').options, [
    '培养角色和当前佩戴武器',
    '培养角色和指定武器',
    '仅培养角色',
    '仅培养指定武器',
  ]);
  assert.ok(names.indexOf('autoWeaponMode') < names.indexOf('selectedCharacter'));
  assert.ok(names.indexOf('selectedCharacter') < names.indexOf('autoCharacterTargetLevel'));
  assert.ok(names.indexOf('autoWeaponMode') < names.indexOf('selectedWeapon'));
  assert.ok(names.indexOf('selectedWeapon') < names.indexOf('weaponLevelRange'));
  for (const removedName of ['characterLevelRange', 'characterNormalAttackRange', 'characterElementalSkillRange',
    'characterElementalBurstRange', 'customTargetsEnabled', 'targetsText']) {
    assert.equal(names.includes(removedName), false, `${removedName} 不应继续出现在公开设置页`);
  }
  assert.ok(names.indexOf('gatheringRouteExecutionEnabled') < names.indexOf('monsterRouteExecutionEnabled'));
  assert.ok(names.indexOf('monsterRouteExecutionEnabled') < names.indexOf('bossRunMode'));
  assert.ok(names.indexOf('bossRunMode') < names.indexOf('advancedSection'));
  assert.ok(names.indexOf('advancedSection') < names.indexOf('resinRuleMode'));
  assert.ok(names.indexOf('resinTaskPriority4') < names.indexOf('resinStrategy'));
  assert.equal(items.find((item) => item.name === 'resinRuleMode').default, '一次只刷一类（推荐）');
  for (const [index, task] of ['世界 Boss', '限时培养秘境', '普通培养秘境', '圣遗物填充'].entries()) {
    const item = items.find((candidate) => candidate.name === `resinTaskPriority${index + 1}`);
    assert.equal(item.type, 'cascade-select');
    assert.equal(item.default.startsWith(`${task}｜`), true);
    assert.equal(item.cascadeOptions[task][0], `${task}｜1 次`);
    assert.equal(item.cascadeOptions[task].at(-1), `${task}｜用完可用树脂`);
  }
  for (const removedName of ['bossMaxClaims', 'limitedDomainMaxClaims', 'domainMaxClaims',
    'artifactDomainMaxClaims', 'resinLimitSection']) assert.equal(names.includes(removedName), false);
  assert.ok(names.indexOf('resinPrioritySection') < names.indexOf('resinTaskPriority1'));
  assert.ok(names.indexOf('resinUsageSection') < names.indexOf('routeTiming'));
  assert.ok(names.indexOf('bossOverridesEnabled') < names.indexOf('bossOverridesText'));
  assert.equal(items.find((item) => item.name === 'bossOverridesEnabled').default, false);
  assert.equal(bossCatalog.bosses.length, 41);
  assert.equal(names.at(-1), 'sendRunSummary');
  assert.equal(items.find((item) => item.name === 'sendRunSummary').default, false);
  assert.equal(items.find((item) => item.name === 'sendRunSummary').label, '发送关键进度与运行摘要');
  const sectionLabels = {
    domainSection: '培养材料秘境',
    gatheringRouteSection: '地方特产路线',
    monsterRouteSection: '怪物材料路线',
    bossSection: '世界 Boss',
    artifactSection: '圣遗物秘境填充',
    advancedSection: '高级设置',
  };
  for (const [sectionName, title] of Object.entries(sectionLabels)) {
    const label = items.find((item) => item.name === sectionName).label;
    assert.match(label, new RegExp(`^\\n━+ ${title} ━+\\n$`));
    assert.ok((label.match(/━/g) ?? []).length >= 34, `${title} 的标题线应接近填满设置窗口`);
  }
  const bossLabel = items.find((item) => item.name === 'bossSection').label;
  assert.equal((bossLabel.match(/━/g) ?? []).length, 36, '世界 Boss 标题不能因右侧重线过长而换行');
});

test('旧版突破前后等级文本可直接读取，未标注的等级默认按突破前计算', () => {
  const rulebook = { characters: { 雅珂达: {} }, weapons: {} };
  const [decorated] = parseTargetText('雅珂达:60级（突破前）>70级（突破后）,1/1/1>6/6/6', rulebook);
  assert.deepEqual(decorated.level, {
    current: 60, target: 70, currentAscended: false, targetAscended: true,
  });
  const [compact] = parseTargetText('雅珂达:60>70', rulebook);
  assert.equal(compact.level.currentAscended, false);
  assert.equal(compact.level.targetAscended, false);
});

test('初始化异常摘要保持简短并包含失败阶段', () => {
  const summary = buildFailureRunSummary({
    stage: '读取培养目标',
    targets: ['雅珂达:60>70'],
    reason: '等级格式错误',
  });
  assert.match(summary, /角色一键养成运行失败/);
  assert.match(summary, /读取培养目标/);
  assert.match(summary, /等级格式错误/);
  assert.ok(summary.length <= 500);
});

test('进度通知使用纯文本并明确区分计划与执行结果', () => {
  assert.equal(buildRunStartSummary(), '角色一键养成已开始\n正在读取培养目标并生成执行计划。');
  assert.equal(shouldSendRunNotifications({ sendRunSummary: false, targetInputMode: '自动档案识别后执行' }), false);
  assert.equal(shouldSendRunNotifications({ sendRunSummary: true, targetInputMode: '自动档案仅预览' }), false);
  assert.equal(shouldSendRunNotifications({ sendRunSummary: true, targetInputMode: '自动档案识别后执行' }), true);
  assert.equal(limitNotificationMessage('已完成'), '已完成');
  assert.equal(limitNotificationMessage(`${'任'.repeat(500)}🙂`).length, 500);
  assert.match(limitNotificationMessage(`${'任'.repeat(500)}🙂`), /…$/);

  const summary = buildPlanReadySummary({
    targetCount: 6,
    targetSummary: [
      '角色 桑多涅：90/90 → 90/90',
      '天赋：爆发8→10',
      '角色 奥黛塔：90/90 → 90/90',
      '天赋：普攻1→6，战技9→10，爆发1→9',
      `补充目标：${'很长'.repeat(300)}`,
    ],
    queue: [
      { targetName: '荒坠的圣迹', maxClaims: 1 },
      { targetName: '逆悬的冰河', maxClaims: null },
      { targetName: '第三项', maxClaims: 2 },
      { targetName: '第四项', maxClaims: 3 },
      { targetName: '不应展开的第五项', maxClaims: 4 },
    ],
  });
  assert.match(summary, /^角色一键养成计划已就绪\n/);
  assert.match(summary, /培养目标：6 项/);
  assert.match(summary, /培养计划\n• 角色 桑多涅：90\/90 → 90\/90/);
  assert.match(summary, /天赋：爆发8→10/);
  assert.match(summary, /计划树脂任务：5 项/);
  assert.match(summary, /荒坠的圣迹（计划最多领奖1次）/);
  assert.match(summary, /逆悬的冰河（计划使用可用预算）/);
  assert.doesNotMatch(summary, /不应展开的第五项/);
  assert.match(summary, /以上仅为计划/);
  assert.match(summary, /…/);
  assert.doesNotMatch(summary, /<[^>]+>/);
  assert.ok(summary.length <= 500);
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

test('合成折算只采用确定的 3:1 配方，不预估角色天赋的概率收益', () => {
  const oneStepRecipes = {
    mid: { resultCount: 1, inputs: [{ id: 'low', count: 3 }] },
  };
  const craftingMaterials = {
    mid: { name: '中阶材料', status: 'manual' },
    low: { name: '低阶材料', status: 'manual' },
  };
  const createCraftingPlan = (lowCount) => createPlan({
    targets: [{ id: 'test', requirements: [{ materialId: 'mid', count: 1 }] }],
    inventory: { mid: 0, low: lowCount },
    materials: craftingMaterials,
    recipes: oneStepRecipes,
    rulebook,
    today: 1,
  });

  const insufficient = createCraftingPlan(2);
  const guaranteed = createCraftingPlan(3);
  assert.equal(insufficient.shortages.find((item) => item.materialId === 'low').shortage, 1);
  assert.equal(guaranteed.shortages.find((item) => item.materialId === 'low').shortage, 0);
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

test('背包读取首次未找到按零计，结束复核未找到则保留原值并标记未知', () => {
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
  assert.deepEqual(applied.notFoundNames, ['天赋书']);
  const omitted = applyInventoryScanResult({}, [{ materialId: '112001', name: '怪物材料' }], {});
  assert.equal(omitted.inventory['112001'], 0);
  assert.deepEqual(omitted.failedNames, []);
  assert.deepEqual(omitted.notFoundNames, ['怪物材料']);
  const finalMissing = applyInventoryScanResult(
    { '112001': 7 },
    [{ materialId: '112001', name: '怪物材料' }],
    { 怪物材料: -1 },
    { notFoundAsUnknown: true },
  );
  assert.equal(finalMissing.inventory['112001'], 7);
  assert.deepEqual(finalMissing.unrecognizedNames, ['怪物材料']);
  assert.deepEqual(finalMissing.notFoundNames, ['怪物材料']);
  const finalOmitted = applyInventoryScanResult(
    { '112001': 7 },
    [{ materialId: '112001', name: '怪物材料' }],
    {},
    { notFoundAsUnknown: true },
  );
  assert.equal(finalOmitted.inventory['112001'], 7);
  assert.deepEqual(finalOmitted.unrecognizedNames, ['怪物材料']);
  const failed = applyInventoryScanResult({}, [{ materialId: '112001', name: '怪物材料' }], { 怪物材料: -2 });
  assert.equal(failed.inventory['112001'], undefined);
  assert.deepEqual(failed.failedNames, ['怪物材料']);
  const preserved = applyInventoryScanResult(
    { '104301': 21 },
    [{ materialId: '104301', name: '天赋书' }],
    {},
    { preserveDecreases: true },
  );
  assert.equal(preserved.inventory['104301'], 21);
  assert.deepEqual(preserved.decreasedNames, ['天赋书']);
});

test('历史确认有库存但本次未找到时记录风险并按零继续规划', () => {
  const chainMaterials = {
    low: { name: '光砂', status: 'supported' },
    mid: { name: '辉岩', status: 'supported' },
    high: { name: '圣骸', status: 'supported' },
  };
  const chainRecipes = {
    high: { resultCount: 1, inputs: [{ id: 'mid', count: 3 }] },
    mid: { resultCount: 1, inputs: [{ id: 'low', count: 3 }] },
  };
  const history = [{
    timestamp: '2026-08-31T17:15:06.000Z',
    targetSummary: ['指定武器 和璞鸢：1 → 90'],
    inventoryAfter: { low: 70, mid: 20, high: 18 },
    execution: { gainSources: { 辉岩: 'task-recognition' } },
  }];
  const conflicts = findHistoricalInventoryConflicts(
    history,
    ['辉岩'],
    chainMaterials,
    ['指定武器 和璞鸢：1 → 90'],
  );
  assert.deepEqual(conflicts, [{
    materialId: 'mid', name: '辉岩', lastCount: 20,
    timestamp: '2026-08-31T17:15:06.000Z', source: 'task-recognition',
  }]);

  const plan = createPlan({
    targets: [{ id: 'weapon', requirements: [{ materialId: 'high', count: 26 }] }],
    inventory: { low: 0, mid: 0, high: 25 },
    materials: chainMaterials,
    recipes: chainRecipes,
    rulebook: {},
    today: 1,
  });
  assert.equal(plan.displayShortages[0].status, 'supported');
  assert.equal(plan.displayShortages[0].shortage, 1);

  const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(source, /本次按 0 继续计算和刷取，可能重复获取/);
  assert.doesNotMatch(source, /已暂停相关合成链任务/);
  assert.doesNotMatch(source, /invalidateCraftingFamilies\(/);
});

test('历史最近一次明确为零时不把更早的正数记录当作冲突', () => {
  const history = [
    { targetSummary: ['目标'], inventoryAfter: { mid: 20 } },
    { targetSummary: ['目标'], inventoryAfter: { mid: 0 } },
  ];
  assert.deepEqual(findHistoricalInventoryConflicts(
    history,
    ['辉岩'],
    { mid: { name: '辉岩' } },
    ['目标'],
  ), []);
});

test('不同培养目标的历史库存不会阻止当前目标调度', () => {
  const history = [{
    targetSummary: ['指定武器 旧武器：1 → 90'],
    inventoryAfter: { mid: 20 },
  }];
  assert.deepEqual(findHistoricalInventoryConflicts(
    history,
    ['辉岩'],
    { mid: { name: '辉岩' } },
    ['指定武器 新武器：1 → 90'],
  ), []);
});

test('自动发现：地方特产跨国别目录，怪物支持别名和嵌套作者目录', () => {
  const folders = new Set([
    '地方特产',
    '地方特产/璃月',
    '地方特产/璃月/清心',
    '敌人与魔物/债务处理人',
    '敌人与魔物/蕈兽',
    '敌人与魔物/蕈兽/蕈兽@翎镞',
  ]);
  const files = new Set([
    '地方特产/璃月/清心/01-清心.json',
    '敌人与魔物/债务处理人/债务处理人-1.json',
    '敌人与魔物/蕈兽/蕈兽@翎镞/蕈兽-地表集中点35只.json',
  ]);
  const children = {
    '地方特产': ['地方特产/璃月'],
    '地方特产/璃月': ['地方特产/璃月/清心'],
    '地方特产/璃月/清心': ['地方特产/璃月/清心/01-清心.json'],
    '敌人与魔物/债务处理人': ['敌人与魔物/债务处理人/债务处理人-1.json'],
    '敌人与魔物/蕈兽': ['敌人与魔物/蕈兽/蕈兽@翎镞'],
    '敌人与魔物/蕈兽/蕈兽@翎镞': ['敌人与魔物/蕈兽/蕈兽@翎镞/蕈兽-地表集中点35只.json'],
  };
  const result = discoverAutoPathingRoutes({
    shortages: [
      { materialId: '100031', shortage: 2 },
      { materialId: '112031', shortage: 3 },
      { materialId: '112059', shortage: 2 },
    ],
    sourceCandidates: {
      '100031': { name: '清心', type: 'localSpecialty', routeNames: ['清心'] },
      '112031': { name: '督察长祭刀', type: 'monster', routeNames: ['愚人众·债务处理人', '债务处理人'] },
      '112059': { name: '蕈兽孢子', type: 'monster', routeNames: ['蕈兽'] },
    },
    pathing: {
      readPaths: (path) => children[path] ?? [],
      isFolder: (path) => folders.has(path),
      isFile: (path) => files.has(path),
    },
  });
  assert.equal(result.matched.length, 3);
  assert.equal(result.missing.length, 0);
  assert.equal(result.matched[0].paths[0], '地方特产/璃月/清心/01-清心.json');
  assert.equal(result.matched[1].paths[0], '敌人与魔物/债务处理人/债务处理人-1.json');
  assert.equal(result.matched[2].paths[0], '敌人与魔物/蕈兽/蕈兽@翎镞/蕈兽-地表集中点35只.json');
});

test('来源候选表缺项时仍按材料名称发现新版地方特产路线', () => {
  const folders = new Set(['地方特产', '地方特产/须弥', '地方特产/须弥/月莲']);
  const files = new Set(['地方特产/须弥/月莲/01-月莲.json']);
  const children = {
    '地方特产': ['地方特产/须弥'],
    '地方特产/须弥': ['地方特产/须弥/月莲'],
    '地方特产/须弥/月莲': ['地方特产/须弥/月莲/01-月莲.json'],
  };
  const result = discoverAutoPathingRoutes({
    shortages: [{
      materialId: '101215', shortage: 60,
      material: { name: '月莲', status: 'manual', executionType: 'none' },
    }],
    sourceCandidates: {},
    pathing: {
      readPaths: (path) => children[path] ?? [],
      isFolder: (path) => folders.has(path),
      isFile: (path) => files.has(path),
    },
  });
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].name, '月莲');
  assert.deepEqual(result.matched[0].paths, ['地方特产/须弥/月莲/01-月莲.json']);
});

test('运行摘要明确未执行状态、候选任务和无历史数据时的预计完成状态', () => {
  const summary = buildRunSummary({
    todayQueue: [{ materialId: 'book', shortage: 12 }],
    shortages: [{ materialId: 'book', shortage: 12 }],
  }, { book: { name: '测试天赋书' } });
  assert.match(summary, /本次未执行/);
  assert.match(summary, /测试天赋书\(12\)/);
  assert.match(summary, /等待累计实际掉落数据/);
  assert.match(summary, /\n\n仍缺材料\n/);
  assert.match(summary, /今日可执行任务/);
  assert.doesNotMatch(summary, /下一步候选/);
});

test('材料已满足时摘要明确无需执行且不再显示开放日文案', () => {
  const summary = buildRunSummary({
    todayQueue: [], displayShortages: [], weeklyStrategy: [], manualItems: [],
  }, {}, {
    executionEnabled: true,
    execution: { status: 'skipped', code: 'no_candidate', reason: '今日没有已启用的树脂任务' },
    estimateDays: 0,
    estimateReason: '材料已满足',
    estimateDetails: [],
  });
  assert.match(summary, /无需执行：培养材料已满足/);
  assert.match(summary, /预计完成：培养材料已满足/);
  assert.doesNotMatch(summary, /当前开放日可刷/);
});

test('库存未确认时预计完成不会误报材料已满足', () => {
  const estimate = buildCompletionEstimate({
    plan: { displayShortages: [{ materialId: 'mid', shortage: null, status: 'unknown' }] },
    materials: { mid: { name: '辉岩', status: 'supported' } },
    today: 1,
  });
  assert.equal(estimate.days, null);
  assert.equal(estimate.reason, '背包库存未确认，暂无法估算');
});

test('库存未确认时邮件列出材料名称而不是误报无缺口', () => {
  const summary = buildRunSummary({
    todayQueue: [],
    displayShortages: [{ materialId: 'mid', shortage: null, status: 'unknown' }],
    weeklyStrategy: [],
  }, { mid: { name: '狮牙斗士的镣铐' } }, {
    executionEnabled: true,
    execution: {
      status: 'skipped',
      reason: '执行前背包识别与历史确认记录冲突，已暂停相关任务',
    },
    estimateDays: null,
    estimateReason: '背包库存未确认，暂无法估算',
  });
  assert.match(summary, /狮牙斗士的镣铐（库存未确认）/);
  assert.doesNotMatch(summary, /仍缺材料\n• 无/);
});

test('运行摘要把周本缺口明确列为手动获取', () => {
  const weeklyMaterial = {
    materialId: 'weekly', shortage: 2, status: 'manual',
    material: { name: '东风的吐息', executionType: 'weeklyBoss' },
  };
  const summary = buildRunSummary({
    todayQueue: [], displayShortages: [weeklyMaterial], manualItems: [weeklyMaterial], weeklyStrategy: [],
  }, { weekly: { name: '东风的吐息' } }, { executionEnabled: true });
  assert.match(summary, /需手动获取的周本材料/);
  assert.match(summary, /东风的吐息×2/);
});

test('运行摘要区分任务调用、背包识别失败、确认收益和圣遗物非材料统计', () => {
  const unconfirmed = buildRunSummary({ todayQueue: [], displayShortages: [], weeklyStrategy: [] }, {}, {
    executionEnabled: true,
    execution: {
      status: 'completed',
      task: { executionType: 'boss', bossName: '守望者·堕天' },
      rewards: {}, trackedRewards: {}, appliedGains: false,
    },
  });
  assert.match(unconfirmed, /世界 Boss：守望者·堕天/);
  assert.match(unconfirmed, /未确认领取到目标材料，可能是树脂不足或奖励识别为空/);
  assert.doesNotMatch(unconfirmed, /已执行完成/);

  const recognitionFailed = buildRunSummary({ todayQueue: [], displayShortages: [], weeklyStrategy: [] }, {}, {
    executionEnabled: true,
    execution: {
      status: 'completed',
      task: { executionType: 'boss', bossName: '守望者·堕天' },
      trackedRewards: {}, appliedGains: false, inventoryChecked: true,
      inventoryRecognitionFailed: true,
      inventoryUnrecognizedNames: ['堕天的落羽'],
    },
  });
  assert.match(recognitionFailed, /奖励结果未知（背包未识别：堕天的落羽）/);
  assert.doesNotMatch(recognitionFailed, /确认收益.*堕天的落羽×/);

  const taskFallback = buildRunSummary({ todayQueue: [], displayShortages: [], weeklyStrategy: [] }, {}, {
    executionEnabled: true,
    execution: {
      status: 'completed',
      task: { executionType: 'boss', bossName: '守望者·堕天' },
      trackedRewards: { 堕天的落羽: 12 }, appliedGains: true, inventoryChecked: true,
      inventoryRecognitionFailed: true,
      inventoryUnrecognizedNames: ['堕天的落羽'],
      gainSources: { 堕天的落羽: 'task-recognition' },
    },
  });
  assert.match(taskFallback, /部分材料由 BetterGI 奖励识别补充确认/);
  assert.match(taskFallback, /堕天的落羽×12/);

  const artifact = buildRunSummary({ todayQueue: [], displayShortages: [], weeklyStrategy: [] }, {}, {
    executionEnabled: true,
    execution: {
      status: 'completed',
      task: { executionType: 'artifactDomain', domainName: '月童的库藏' },
      rewards: {}, trackedRewards: {}, appliedGains: false,
    },
  });
  assert.match(artifact, /圣遗物任务调用结束/);
  assert.match(artifact, /圣遗物收益不纳入培养材料计数/);
});

test('运行摘要会明确显示未确认增长的路线', () => {
  const summary = buildRunSummary({
    todayQueue: [], displayShortages: [], weeklyStrategy: [],
  }, {}, {
    executionEnabled: true,
    execution: {
      status: 'skipped',
      reason: '今日没有树脂任务',
      routes: [{ name: '月莲', status: 'unconfirmed', reason: '未确认增长', gained: {} }],
    },
  });
  assert.match(summary, /部分路线未确认材料增长/);
  assert.match(summary, /月莲：未确认增长/);
});

test('完成预估按最高难度培养秘境期望和开放日推算', () => {
  const estimateMaterials = {
    book: { name: '测试书', status: 'supported', executionType: 'domain', domainName: '测试秘境', openDays: [1, 4, 0] },
  };
  const estimate = buildCompletionEstimate({
    plan: { displayShortages: [{ materialId: 'book', shortage: 5 }] },
    materials: estimateMaterials,
    today: 1,
    recipes: {},
  });
  assert.equal(estimate.days, 0);
  assert.equal(estimate.details[0].estimatedClaims, 1);
  assert.equal(estimate.details[0].estimatedResin, 20);
  assert.equal(estimate.details[0].requiredOpenDays, 1);
  assert.match(estimate.reason, /世界等级 9/);
});

test('运行摘要把领奖次数、树脂、开放日和自然日分别显示', () => {
  const summary = buildRunSummary({ todayQueue: [], displayShortages: [], weeklyStrategy: [] }, {}, {
    estimateDays: 3,
    estimateReason: '按最高难度掉落期望估算',
    estimateDetails: [{ estimatedClaims: 14, estimatedResin: 280, requiredOpenDays: 2 }],
  });
  assert.match(summary, /约14次领奖、280树脂、2个开放日/);
  assert.match(summary, /从现在起最早约3个自然日/);
  assert.ok(summary.length <= 500);
});

test('当天开放时预计完成不再把树脂耗尽后的任务写成最早今天完成', () => {
  const summary = buildRunSummary({ todayQueue: [], displayShortages: [], weeklyStrategy: [] }, {}, {
    estimateDays: 0,
    estimateReason: '按最高难度掉落期望估算',
    estimateDetails: [{ sourceType: 'domain', estimatedClaims: 4, estimatedResin: 80, requiredOpenDays: 1 }],
  });
  assert.match(summary, /约4次领奖、80树脂、1个开放日/);
  assert.match(summary, /当前开放日可刷/);
  assert.match(summary, /若本次树脂已用完则等待下一个开放日/);
  assert.doesNotMatch(summary, /最早今天/);
});

test('完成预估按世界等级 9 Boss 的 3.1 个期望计算', () => {
  const estimateMaterials = {
    core: { name: '测试首领材料', status: 'supported', executionType: 'boss', bossName: '测试首领', openDays: [0, 1, 2, 3, 4, 5, 6] },
  };
  const estimate = buildCompletionEstimate({
    plan: { displayShortages: [{ materialId: 'core', shortage: 5 }] },
    materials: estimateMaterials,
    today: 1,
  });
  assert.equal(estimate.days, 0);
  assert.equal(estimate.details[0].expectedBaseYield, 3.1);
  assert.equal(estimate.details[0].estimatedClaims, 2);
  const summary = buildRunSummary({ todayQueue: [], displayShortages: [], weeklyStrategy: [] }, {}, {
    estimateDays: estimate.days,
    estimateReason: estimate.reason,
    estimateDetails: estimate.details,
  });
  assert.match(summary, /按每日树脂预算约1天/);
  assert.doesNotMatch(summary, /开放日/);
});

test('周本材料不会遮挡可自动执行 Boss 的预计完成信息', () => {
  const estimate = buildCompletionEstimate({
    plan: { displayShortages: [
      { materialId: 'boss', shortage: 8 },
      { materialId: 'weekly', shortage: 6 },
    ] },
    materials: {
      boss: { name: '堕天的落羽', status: 'supported', executionType: 'boss', bossName: '守望者·堕天', openDays: [0, 1, 2, 3, 4, 5, 6] },
      weekly: { name: '狂人的约束', status: 'supported', executionType: 'weeklyBoss', domainName: '赝月的研究所' },
    },
    today: 4,
  });
  assert.equal(estimate.details[0].estimatedClaims, 3);
  assert.match(estimate.reason, /周本材料不显示预计天数/);
  const weeklyStrategy = Array.from({ length: 7 }, (_, index) => ({
    label: `第${index + 1}天`,
    tasks: [{ materialName: '守望者·堕天' }],
  }));
  const summary = buildRunSummary({
    todayQueue: [{ executionType: 'boss', bossName: '守望者·堕天', materials: [{ materialName: '堕天的落羽', shortage: 8 }] }],
    displayShortages: [
      { materialId: 'boss', shortage: 8 },
      { materialId: 'weekly', shortage: 6 },
    ],
    manualItems: [{ materialId: 'weekly', shortage: 6, material: { executionType: 'weeklyBoss' } }],
    weeklyStrategy,
  }, {
    boss: { name: '堕天的落羽' },
    weekly: { name: '狂人的约束' },
  }, {
    estimateDays: estimate.days,
    estimateReason: estimate.reason,
    estimateDetails: estimate.details,
  });
  assert.match(summary, /约3次领奖、120树脂/);
  assert.ok(summary.length <= 500);
});

test('完成预估不为周本和圣遗物输出预计天数', () => {
  const weekly = buildCompletionEstimate({
    plan: { displayShortages: [{ materialId: 'weekly', shortage: 1 }] },
    materials: { weekly: { name: '测试周本材料', status: 'supported', executionType: 'weeklyBoss', domainName: '测试周本', openDays: [0] } },
    today: 1,
  });
  assert.equal(weekly.days, null);
  assert.match(weekly.reason, /周本/);
});

test('路线没有本次已匹配路径时不虚构预计天数', () => {
  const estimate = buildCompletionEstimate({
    plan: {
      displayShortages: [{
        materialId: 'route', shortage: 10,
        material: { name: '测试特产', status: 'supported', executionType: 'route' },
      }],
    },
    materials: { route: { name: '测试特产', status: 'manual', executionType: 'none' } },
    today: 1,
  });
  assert.equal(estimate.days, null);
  assert.match(estimate.reason, /缺少已匹配路线/);
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
  }, { gatheringRouteExecutionEnabled: true });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /秘境队伍/);
  assert.match(warnings[1], /采集队伍/);
});

test('执行前警告同时提供统一状态结构', () => {
  const plan = { todayQueue: [{ executionType: 'domain', status: 'supported' }], routes: { matched: [], missing: [] } };
  const outcomes = collectExecutionWarningOutcomes(plan, {});
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].code, 'config_warning');
  assert.equal(outcomes[0].stage, 'preflight');
  assert.match(outcomes[0].message, /秘境队伍/);
});

test('秘境树脂策略默认先使用浓缩树脂，再使用原粹树脂', () => {
  const policy = buildDomainResinPolicy({});
  assert.deepEqual(policy.priority, ['浓缩树脂', '原粹树脂']);
  assert.equal(policy.originalResinUseCount, 9999);
  assert.equal(policy.condensedResinUseCount, 9999);
  assert.equal(policy.fragileResinUseCount, 0);
});

test('培养秘境单次测试不受正式树脂开关关闭影响', () => {
  const warnings = collectExecutionWarnings({
    todayQueue: [{ executionType: 'domain' }],
    routes: { matched: [] },
  }, {
    domainTeamName: '秘境队',
    domainTestSingleRun: true,
    domainUseOriginalResin: false,
    domainUseCondensedResin: false,
  });
  assert.equal(warnings.some((warning) => warning.includes('树脂类型均已关闭')), false);
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
    execution: { status: 'completed', task: { executionType: 'boss', bossName: '测试首领', materialName: '测试首领' }, trackedRewards: { 测试天赋书: 2 } },
    domainResinPolicy: { condensedResinUseCount: 1 },
  });
  assert.equal(record.execution.trackedRewards.测试天赋书, 2);
  assert.equal(record.execution.task.bossName, '测试首领');
  assert.equal(record.execution.evidence.inventoryGainConfirmed, false);
  assert.equal(record.execution.evidence.materialTrackingApplicable, true);
  assert.equal(record.execution.result, 'completed-unconfirmed');
  assert.deepEqual(record.remainingShortages, [{ materialId: 'book', shortage: 3 }]);
  const history = appendRunHistory(Array.from({ length: 100 }, (_, index) => ({ index })), record);
  assert.equal(history.length, 100);
  assert.equal(history.at(-1), record);
});

test('运行记录把结束背包漏识别保存为未知结果', () => {
  const record = buildRunRecord({
    executionEnabled: true,
    plan: { displayShortages: [] },
    inventoryBefore: { boss: 0 },
    inventoryAfter: { boss: 0 },
    execution: {
      status: 'completed',
      task: { executionType: 'boss', bossName: '测试首领', materialName: '测试首领' },
      inventoryChecked: true,
      inventoryRecognitionFailed: true,
      inventoryUnrecognizedNames: ['测试材料'],
    },
    domainResinPolicy: {},
  });
  assert.equal(record.execution.result, 'completed-inventory-unrecognized');
  assert.equal(record.execution.evidence.inventoryRecognitionFailed, true);
  assert.deepEqual(record.execution.evidence.inventoryUnrecognizedNames, ['测试材料']);
});

test('运行记录保存任务奖励兜底来源与证据差异', () => {
  const record = buildRunRecord({
    executionEnabled: true,
    plan: { displayShortages: [{ materialId: 'boss', shortage: 8 }] },
    inventoryBefore: { boss: 0 },
    inventoryAfter: { boss: 12 },
    execution: {
      status: 'completed',
      task: { executionType: 'boss', bossName: '守望者·堕天', materialName: '守望者·堕天' },
      taskRecognizedRewards: { 堕天的落羽: 12, 摩拉: 32000 },
      inventoryTrackedRewards: {},
      taskTrackedRewards: { 堕天的落羽: 12 },
      trackedRewards: { 堕天的落羽: 12 },
      gainSources: { 堕天的落羽: 'task-recognition' },
      rewardDiscrepancies: [],
      inventoryChecked: true,
      inventoryRecognitionFailed: true,
      inventoryUnrecognizedNames: ['堕天的落羽'],
      inventoryBeforeNotFoundNames: ['堕天的落羽'],
      inventoryAfterNotFoundNames: ['堕天的落羽'],
      appliedGains: true,
    },
    domainResinPolicy: {},
  });
  assert.equal(record.execution.result, 'completed-task-recognition-confirmed');
  assert.equal(record.execution.evidence.taskRecognitionGainConfirmed, true);
  assert.equal(record.execution.taskRecognizedRewards.堕天的落羽, 12);
  assert.equal(record.execution.gainSources.堕天的落羽, 'task-recognition');
  assert.deepEqual(record.execution.inventoryBeforeNotFoundNames, ['堕天的落羽']);
  assert.deepEqual(record.execution.evidence.inventoryAfterNotFoundNames, ['堕天的落羽']);
});

test('运行记录保存统一任务结果和非覆盖性警告', () => {
  const execution = createRunExecution({
    task: { executionType: 'boss', bossName: '急冻树', materialName: '急冻树' },
    status: 'completed', code: 'reward_confirmed', stage: 'reward', message: '已确认收益',
    warnings: [createExecutionOutcome({
      status: 'unconfirmed', code: 'cleanup_failed', stage: 'cleanup', severity: 'warning',
      taskType: 'boss', targetName: '急冻树', message: '传送神像失败',
    })],
  });
  execution.appliedGains = true;
  execution.inventoryChecked = true;
  const record = buildRunRecord({
    executionEnabled: true, plan: { displayShortages: [] }, inventoryBefore: {}, inventoryAfter: {},
    execution, domainResinPolicy: {},
  });
  assert.equal(record.execution.code, 'reward_confirmed');
  assert.equal(record.execution.tasks[0].targetName, '急冻树');
  assert.equal(record.execution.warnings[0].code, 'cleanup_failed');
  assert.equal(record.execution.status, 'completed');
});

test('存在可执行世界 Boss 时，秘境不得抢占执行顺序', () => {
  assert.equal(hasPendingOriginalResinTask([{ executionType: 'weeklyBoss', status: 'supported' }]), false);
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

test('地方特产和怪物材料路线可以独立开启', () => {
  const routes = {
    matched: [
      { materialId: 'local', name: '测试特产', type: 'localSpecialty', shortage: 1, paths: ['地方特产/测试.json'] },
      { materialId: 'monster', name: '测试怪物材料', type: 'monster', shortage: 1, paths: ['敌人与魔物/测试.json'] },
    ],
  };
  const gatheringOnly = buildRouteExecutionPlan(routes, {
    gatheringRouteExecutionEnabled: true,
    monsterRouteExecutionEnabled: false,
    gatheringTeamName: '采集队',
  });
  assert.deepEqual(gatheringOnly.map((item) => item.type), ['localSpecialty']);
  const monsterOnly = buildRouteExecutionPlan(routes, {
    gatheringRouteExecutionEnabled: false,
    monsterRouteExecutionEnabled: true,
    monsterTeamName: '怪物队',
  });
  assert.deepEqual(monsterOnly.map((item) => item.type), ['monster']);
});

test('同一路线命中多个材料等级时只执行一次并读取完整合成链', () => {
  const sharedPath = '敌人与魔物/蕈兽/作者/蕈兽.json';
  const routes = {
    matched: [
      { materialId: '112059', name: '蕈兽孢子', type: 'monster', shortage: 2, paths: [sharedPath] },
      { materialId: '112061', name: '孢囊晶尘', type: 'monster', shortage: 16, paths: [sharedPath] },
    ],
  };
  const recipes = {
    '112060': { resultCount: 1, inputs: [{ id: '112059', count: 3 }] },
    '112061': { resultCount: 1, inputs: [{ id: '112060', count: 3 }] },
  };
  const plan = buildRouteExecutionPlan(routes, {
    routeExecutionEnabled: true,
    monsterTeamName: '怪物队',
  }, recipes);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].paths.length, 1);
  assert.deepEqual(plan[0].materials.map((item) => item.materialId), ['112059', '112061']);
  assert.deepEqual(new Set(plan[0].scanMaterialIds), new Set(['112059', '112060', '112061']));
});

test('同一材料的多条订阅路径保留为一个路线任务', () => {
  const paths = [
    '地方特产/月莲/01.json',
    '地方特产/月莲/02.json',
    '地方特产/月莲/03.json',
  ];
  const plan = buildRouteExecutionPlan({
    matched: [{ materialId: '101215', name: '月莲', type: 'localSpecialty', shortage: 46, paths }],
  }, {
    routeExecutionEnabled: true,
    gatheringTeamName: '采集队',
  });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0].paths, paths);
});

test('已订阅路线只通过 User AutoPathing 接口执行', async () => {
  const calls = [];
  await runSubscribedRouteFile({
    isFile: (path) => path === '地方特产/月莲.json',
    runFileFromUser: async (path) => calls.push(path),
  }, '地方特产/月莲.json');
  assert.deepEqual(calls, ['地方特产/月莲.json']);
  await assert.rejects(() => runSubscribedRouteFile({
    isFile: () => false,
    runFileFromUser: async () => {},
  }, '不存在.json'), /路线文件不存在/);
});

test('全部任务结束后用一次背包总差值回填路线收益', () => {
  const records = [{
    name: '月莲', type: 'localSpecialty', status: 'pendingInventoryCheck', reason: '等待统一复核',
    paths: [{ path: '地方特产/月莲/01.json' }],
    materials: [{ materialId: '101215', name: '月莲', shortage: 20, gained: 0 }],
    gained: { 月莲: 0 },
  }];
  const result = applyFinalRouteInventoryGains(
    records,
    { '101215': 10 },
    { '101215': 26 },
  );
  assert.equal(result[0].status, 'completed');
  assert.equal(result[0].code, 'reward_confirmed');
  assert.equal(result[0].stage, 'reward');
  assert.equal(result[0].reason, null);
  assert.equal(result[0].materials[0].gained, 16);
  assert.deepEqual(result[0].gained, { 月莲: 16 });
});

test('执行前背包漏识别时路线不得把结束库存总量误报为本次收益', () => {
  const records = [{
    name: '月莲', type: 'localSpecialty', status: 'pendingInventoryCheck', reason: '等待统一复核',
    materials: [{ materialId: '101215', name: '月莲', shortage: 20, gained: 0 }],
    gained: { 月莲: 0 },
  }];
  const result = applyFinalRouteInventoryGains(
    records,
    { '101215': 0 },
    { '101215': 120 },
    { unreliableMaterialIds: ['101215'] },
  );
  assert.equal(result[0].status, 'unconfirmed');
  assert.equal(result[0].materials[0].gained, 0);
  assert.deepEqual(result[0].gained, { 月莲: 0 });
});

test('已匹配路线从人工待办升级为路线执行来源', () => {
  const item = {
    materialId: '101215', shortage: 20, status: 'manual', reason: '尚未配置已验证的执行适配',
    material: { name: '月莲', status: 'manual', executionType: 'none' },
  };
  const plan = { shortages: [item], displayShortages: [item], manualItems: [item] };
  applyMatchedRouteSupport(plan, {
    matched: [{ materialId: '101215', type: 'localSpecialty', source: 'autoDiscovered' }],
  });
  assert.equal(plan.displayShortages[0].status, 'supported');
  assert.equal(plan.displayShortages[0].material.executionType, 'route');
  assert.equal(plan.displayShortages[0].material.routeType, 'localSpecialty');
  assert.match(plan.displayShortages[0].reason, /已自动匹配/);
  assert.deepEqual(plan.manualItems, []);
});

test('周本材料保留为手动获取项，且不会阻塞同日 Boss 和秘境', () => {
  const shortages = [
    {
      materialId: 'weekly-1', shortage: 3,
      material: { name: '东风的吐息', executionType: 'weeklyBoss', domainName: '深入风龙废墟', openDays: [0], status: 'supported', priority: 200 },
    },
    {
      materialId: 'weekly-2', shortage: 2,
      material: { name: '东风之爪', executionType: 'weeklyBoss', domainName: '深入风龙废墟', openDays: [0], status: 'supported', priority: 200 },
    },
    {
      materialId: 'boss', shortage: 4,
      material: { name: '极寒之核', executionType: 'boss', bossName: '急冻树', openDays: [0], status: 'supported', priority: 100 },
    },
    {
      materialId: 'book', shortage: 6,
      material: { name: '「抗争」的指引', executionType: 'domain', domainName: '忘却之峡', openDays: [0], status: 'supported', priority: 50 },
    },
  ];
  const plan = buildPlan(shortages, 0);
  assert.deepEqual(plan.todayQueue.map((item) => item.executionType), ['boss', 'domain']);
  assert.equal(plan.manualItems.length, 2);
  assert.ok(plan.manualItems.every((item) => item.status === 'manual'));
  assert.ok(plan.manualItems.every((item) => /当前版本需手动获取/.test(item.reason)));
});

test('世界 Boss 执行器只允许原粹树脂并要求独立队伍', () => {
  const config = buildBossExecutionConfig({
    executionType: 'boss', bossName: '急冻树', materialId: '113010', materialName: '极寒之核', shortage: 4,
  }, { bossTeamName: 'Boss 队伍', bossCombatStrategyName: '急冻树策略' });
  assert.equal(config.bossName, '急冻树');
  assert.equal(config.partyName, 'Boss 队伍');
  assert.equal(config.runCount, 9999);
  assert.equal(config.specifyRunCount, false);
  assert.equal(config.strategyName, '急冻树策略');
  const singleRunConfig = buildBossExecutionConfig({
    executionType: 'boss', bossName: '急冻树', materialId: '113010', materialName: '极寒之核', shortage: 4,
  }, { bossTeamName: 'Boss 队伍', bossTestSingleRun: true });
  assert.equal(singleRunConfig.specifyRunCount, true);
  assert.equal(singleRunConfig.runCount, 1);
  assert.equal(singleRunConfig.strategyName, '');
  const overrideConfig = buildBossExecutionConfig({
    executionType: 'boss', bossName: '急冻树', materials: [],
  }, {
    bossTeamName: '通用队伍', bossCombatStrategyName: '通用策略',
    bossOverrides: { 急冻树: { partyName: '专属队伍', strategyName: '专属策略' } },
  });
  assert.equal(overrideConfig.partyName, '专属队伍');
  assert.equal(overrideConfig.strategyName, '专属策略');
  assert.equal(isBossTaskEnabled({ bossName: '急冻树' }, { bossExecutionEnabled: true }), true);
  assert.equal(isBossTaskEnabled({ bossName: '急冻树' }, {
    bossExecutionEnabled: true, bossOverrides: { 急冻树: { enabled: false } },
  }), false);
  assert.equal(isBossTaskEnabled({ bossName: '急冻树' }, { bossExecutionEnabled: false }), false);
  assert.throws(() => buildBossExecutionConfig({ executionType: 'boss', bossName: '急冻树' }, {
    bossTeamName: '通用队伍', bossOverrides: { 急冻树: { enabled: false } },
  }), /已被单独禁用/);
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

test('运行摘要显示未确认结果和清理警告，不把任务写成完成', () => {
  const execution = createRunExecution({
    task: { executionType: 'boss', bossName: '急冻树' },
    status: 'unconfirmed', code: 'reward_unconfirmed', stage: 'reward', message: '未确认领取到目标材料',
    warnings: [createExecutionOutcome({
      status: 'unconfirmed', code: 'cleanup_failed', stage: 'cleanup', severity: 'warning',
      targetName: '急冻树', message: '传送神像失败',
    })],
  });
  const summary = buildRunSummary({ todayQueue: [], displayShortages: [], weeklyStrategy: [] }, {}, {
    executionEnabled: true, execution,
  });
  assert.match(summary, /任务结果未确认/);
  assert.match(summary, /运行警告/);
  assert.match(summary, /传送神像失败/);
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

test('同一错误队伍连续失败后，本次运行不再重复切换', async () => {
  const calls = [];
  const state = { initialized: true };
  const options = {
    partyName: '不存在的队伍', taskLabel: '采集', state,
    logger: { info: () => {}, warn: () => calls.push('warn') },
    teleportToStatue: async () => calls.push('statue'),
    switchParty: async () => { calls.push('switch'); return false; },
  };
  assert.equal(await switchPartyWithRecovery(options), false);
  assert.deepEqual(calls, ['switch', 'warn', 'statue', 'switch']);

  assert.equal(await switchPartyWithRecovery(options), false);
  assert.deepEqual(calls, ['switch', 'warn', 'statue', 'switch', 'warn']);
});

test('执行前检查只提示默认关闭的 Boss 自动执行', () => {
  const warnings = collectExecutionWarnings({
    todayQueue: [
      { executionType: 'weeklyBoss', status: 'supported' },
      { executionType: 'boss', status: 'supported' },
    ],
  }, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Boss 自动执行默认关闭/);
  const overrideWarnings = collectExecutionWarnings({
    todayQueue: [{ executionType: 'boss', bossName: '急冻树', status: 'supported' }],
  }, {
    bossExecutionEnabled: true,
    bossOverrides: { 急冻树: { partyName: '专属队伍' } },
  });
  assert.deepEqual(overrideWarnings, []);
  const disabledWarnings = collectExecutionWarnings({
    todayQueue: [{ executionType: 'boss', bossName: '无相之水', status: 'supported' }],
  }, {
    bossExecutionEnabled: true,
    bossOverrides: { 无相之水: { enabled: false } },
  });
  assert.deepEqual(disabledWarnings, []);
});

test('路线开关开启但材料已满足时不误报，存在未匹配缺口时才警告', () => {
  const noShortageWarnings = collectExecutionWarnings({
    todayQueue: [], routes: { matched: [], missing: [] },
  }, { gatheringRouteExecutionEnabled: true, monsterRouteExecutionEnabled: true });
  assert.deepEqual(noShortageWarnings, []);

  const missingWarnings = collectExecutionWarnings({
    todayQueue: [],
    routes: { matched: [], missing: [{ type: 'monster', name: '蕈兽孢子' }] },
  }, { monsterRouteExecutionEnabled: true });
  assert.equal(missingWarnings.length, 1);
  assert.match(missingWarnings[0], /蕈兽孢子/);
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
  const withDisabledBoss = { todayQueue: [{ executionType: 'boss', bossName: '无相之水', status: 'supported' }] };
  appendArtifactFallbackTask(withDisabledBoss, {
    artifactDomainEnabled: true,
    artifactDomainName: '芬德尼尔之顶',
    bossExecutionEnabled: true,
    bossOverrides: { 无相之水: { enabled: false } },
  });
  assert.equal(withDisabledBoss.todayQueue.at(-1).executionType, 'artifactDomain');
  const withEnabledBoss = { todayQueue: [{ executionType: 'boss', bossName: '急冻树', status: 'supported' }] };
  appendArtifactFallbackTask(withEnabledBoss, {
    artifactDomainEnabled: true, artifactDomainName: '芬德尼尔之顶', bossExecutionEnabled: true,
  });
  assert.equal(withEnabledBoss.todayQueue.length, 1);
  const config = buildArtifactDomainExecutionConfig(plan.todayQueue[0], { artifactDomainEnabled: true, artifactTeamName: '圣遗物队伍' }, buildDomainResinPolicy({}));
  assert.equal(config.domainName, '芬德尼尔之顶');
  assert.equal(config.autoArtifactSalvage, false);
  const singleRunConfig = buildArtifactDomainExecutionConfig(plan.todayQueue[0], {
    artifactDomainEnabled: true,
    artifactTeamName: '圣遗物队伍',
    artifactTestSingleRun: true,
  }, buildDomainResinPolicy({}));
  assert.equal(singleRunConfig.testSingleRun, true);
  assert.deepEqual(singleRunConfig.resinPolicy.priority, ['原粹树脂']);
  assert.equal(singleRunConfig.resinPolicy.originalResinUseCount, 0);
  assert.equal(singleRunConfig.resinPolicy.originalResin20UseCount, 1);
  assert.equal(singleRunConfig.resinPolicy.originalResin40UseCount, 0);
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
    { executionType: 'domain', domainName: '太山府', day: 0 },
    { domainTeamName: '秘境队' }, buildDomainResinPolicy({}),
  ), /未配置正确的奖励序号/);
  const sundayConfig = buildDomainExecutionConfig(
    { executionType: 'domain', domainName: '太山府', sundaySelectedValue: '2' },
    { domainTeamName: '秘境队', weekday: '0' }, buildDomainResinPolicy({}),
  );
  assert.equal(sundayConfig.sundaySelectedValue, '2');
});

test('培养秘境单次测试只允许领取一次原粹树脂奖励', () => {
  const config = buildDomainExecutionConfig(
    { executionType: 'domain', domainName: '太山府', materials: [] },
    { domainTeamName: '秘境队', domainTestSingleRun: true },
    buildDomainResinPolicy({}),
  );
  assert.equal(config.testSingleRun, true);
  assert.deepEqual(config.resinPolicy.priority, ['原粹树脂']);
  assert.equal(config.resinPolicy.originalResinUseCount, 0);
  assert.equal(config.resinPolicy.originalResin20UseCount, 1);
  assert.equal(config.resinPolicy.originalResin40UseCount, 0);
  assert.equal(config.resinPolicy.condensedResinUseCount, 0);
  assert.equal(config.resinPolicy.transientResinUseCount, 0);
  assert.equal(config.resinPolicy.fragileResinUseCount, 0);

  const disabledPolicy = buildDomainResinPolicy({
    domainUseOriginalResin: false,
    domainUseCondensedResin: false,
  });
  assert.doesNotThrow(() => buildDomainExecutionConfig(
    { executionType: 'domain', domainName: '太山府', materials: [] },
    { domainTeamName: '秘境队', domainTestSingleRun: true },
    disabledPolicy,
  ));
});
