import { createPlan } from './core/planner.js';
import { applyInventoryScanResult, buildInventoryScanGroups } from './core/inventory.js';
import { discoverAutoPathingRoutes } from './core/routes.js';
import { buildRunSummary } from './core/report.js';
import { collectExecutionWarnings } from './core/preflight.js';
import { buildDomainResinPolicy } from './core/resin.js';
import { buildDomainExecutionConfig } from './core/domain-executor.js';
import { buildTrackedInventoryGains } from './core/execution-progress.js';
import { buildWeeklyStrategy } from './core/scheduler.js';
import { appendRunHistory, buildRunRecord } from './core/history.js';
import { parseTargetText } from './core/target-input.js';
import { resolvePlanningWeekday } from './core/server-weekday.js';
import { buildCompletionEstimate } from './core/estimate.js';
import { buildRouteExecutionPlan } from './core/route-executor.js';
import { buildWeeklyBossExecutionConfig } from './core/weekly-executor.js';
import { buildBossExecutionConfig } from './core/boss-executor.js';

async function main() {
  const executionEnabled = isExecutionEnabled(settings.planOnly);
  log.info('[模式] 当前为{mode}；planOnly 原始值={value}', executionEnabled ? '实际执行模式' : '仅计划模式', String(settings.planOnly));

  const materials = JSON.parse(file.readTextSync('data/materials.json'));
  const recipes = JSON.parse(file.readTextSync('data/crafting-recipes.json'));
  const rulebook = JSON.parse(file.readTextSync('data/rulebook.json'));
  const targetData = loadTargets(settings, rulebook);
  const sourceCandidates = JSON.parse(file.readTextSync('data/source-candidates.json'));
  const routeOverrides = JSON.parse(file.readTextSync('data/route-overrides.json'));
  const today = resolvePlanningWeekday({
    automatic: settings.useServerWeekday !== false,
    manualWeekday: settings.weekday,
    nowMs: Date.now(),
    serverOffsetMs: ServerTime.GetServerTimeZoneOffset(),
  });
  log.info('[初始化] 目标数量：{count}；计划日：{day}（{source}）', (targetData.targets ?? []).length, today,
    settings.useServerWeekday !== false ? '服务器时间 04:00 刷新规则' : '手动指定');
  for (const target of targetData.targets ?? []) {
    log.info('[目标] {kind}：{name}', target.kind, target.name);
  }

  let inventory = targetData.inventory ?? {};
  let plan = createPlan({
    targets: targetData.targets ?? [],
    inventory,
    materials,
    recipes,
    rulebook,
    today,
  });

  // 兼容 BetterGI 已保存的旧设置：字段不存在时也默认开启读取。
  if (settings.scanInventory !== false) {
    inventory = await scanInventoryMaterials(plan, inventory, materials, '执行前');

    plan = createPlan({
      targets: targetData.targets ?? [],
      inventory,
      materials,
      recipes,
      rulebook,
      today,
    });
  } else {
    log.info('[背包] 已关闭自动读取，库存仅使用目标文件中的 inventory 字段');
  }

  if (settings.discoverRoutes !== false) {
    try {
      plan.routes = discoverAutoPathingRoutes({
        shortages: plan.displayShortages,
        sourceCandidates,
        routeOverrides,
        pathing: {
          readPaths: (path) => Array.from(pathingScript.ReadPathSync(path)),
          isFolder: (path) => pathingScript.IsFolder(path),
          isFile: (path) => pathingScript.IsFile(path),
        },
      });
      for (const item of plan.routes.matched) {
        log.info('[路线] 已匹配 {type}“{name}”：{count} 条；{source}', item.type, item.name, item.paths.length, item.source);
      }
      for (const item of plan.routes.missing) {
        log.warn('[路线] 未匹配 {type}“{name}”：{reason}', item.type, item.name, item.reason);
      }
    } catch (error) {
      plan.routes = { matched: [], missing: [], error: error.message ?? String(error) };
      log.error('[路线] 自动检查已订阅路线失败：{error}', plan.routes.error);
    }
  } else {
    log.info('[路线] 已关闭已订阅路线检查');
  }

  const executionWarnings = collectExecutionWarnings(plan, settings);
  for (const warning of executionWarnings) {
    log.warn('[执行前检查] {warning}', warning);
  }
  const domainResinPolicy = buildDomainResinPolicy(settings);
  plan.weeklyStrategy = buildWeeklyStrategy(plan.weeklyPlan, today);
  const discoveredRoutes = plan.routes;
  log.info('[树脂] 秘境策略：指定使用={specified}；BetterGI 实际顺序={priority}；原粹/浓缩/须臾/脆弱上限={original}/{condensed}/{transient}/{fragile}',
    domainResinPolicy.specifyResinUse,
    domainResinPolicy.priority.join('、') || '无',
    domainResinPolicy.originalResinUseCount,
    domainResinPolicy.condensedResinUseCount,
    domainResinPolicy.transientResinUseCount,
    domainResinPolicy.fragileResinUseCount);
  plan.domainResinPolicy = domainResinPolicy;
  const inventoryBeforeExecution = { ...inventory };

  if (executionEnabled) {
    let execution;
    try {
      execution = await executeFirstResinTask(plan, settings, domainResinPolicy, materials, inventory);
    } catch (error) {
      execution = {
        status: 'failed',
        reason: error.message ?? String(error),
        rewards: {},
        appliedGains: false,
      };
      log.error('[执行] 未开始或未完成秘境刷取：{error}', execution.reason);
    }
    plan.execution = execution;
    if (execution.status === 'completed' && settings.scanInventory !== false) {
      inventory = await scanInventoryMaterials(plan, inventory, materials, '执行后');
      execution.trackedRewards = buildTrackedInventoryGains(
        inventoryBeforeExecution,
        inventory,
        getTrackedMaterialIds(execution.task),
        materials,
      );
      execution.appliedGains = Object.keys(execution.trackedRewards).length > 0;
      if (execution.appliedGains) {
        log.info('[执行] 已按背包前后差值确认目标材料收益：{rewards}', JSON.stringify(execution.trackedRewards));
      } else {
        log.warn('[执行] 执行后背包未确认到目标材料增长，可能是奖励识别或背包 OCR 失败');
      }
      plan = createPlan({
        targets: targetData.targets ?? [],
        inventory,
        materials,
        recipes,
        rulebook,
        today,
      });
      plan.domainResinPolicy = domainResinPolicy;
      plan.weeklyStrategy = buildWeeklyStrategy(plan.weeklyPlan, today);
      plan.routes = discoveredRoutes;
      plan.execution = execution;
    }
    if (execution.status !== 'failed' && settings.routeExecutionEnabled === true) {
      const routeExecution = await executeMatchedRoutes(discoveredRoutes, settings, inventory, materials);
      execution.routes = routeExecution.records;
      if (Object.keys(routeExecution.gains).length > 0) {
        execution.trackedRewards = { ...(execution.trackedRewards ?? {}), ...routeExecution.gains };
        execution.appliedGains = true;
      }
      inventory = routeExecution.inventory;
      plan = createPlan({
        targets: targetData.targets ?? [],
        inventory,
        materials,
        recipes,
        rulebook,
        today,
      });
      plan.routes = discoveredRoutes;
      plan.weeklyStrategy = buildWeeklyStrategy(plan.weeklyPlan, today);
      plan.domainResinPolicy = domainResinPolicy;
      plan.execution = execution;
    }
  }

  log.info('[计算] 已生成 {count} 项实际刷取缺口', plan.displayShortages.length);
  for (const craft of plan.crafting.craftPlan) {
    const name = materials[craft.materialId]?.name ?? craft.materialId;
    const inputs = craft.inputs.map((input) => `${materials[input.id]?.name ?? input.id} ×${input.count * craft.craftCount}`).join('、');
    log.info('[合成] {name} ×{count}（消耗：{inputs}）', name, craft.craftCount, inputs);
  }
  for (const item of plan.displayShortages) {
    const name = item.material?.name ?? item.materialId;
    const owned = item.owned ?? '未确认';
    const shortage = item.shortage ?? '不计算';
    log.info('[材料] {name} | 实际需刷={required} | 当前库存={owned} | 缺口={shortage} | 状态={status} | 原因={reason}',
      name, item.required, owned, shortage, item.status, item.reason ?? '无');
  }
  for (const task of plan.todayQueue) {
    const name = task.materials
      ? task.materials.map((item) => `${item.materialName}×${item.shortage}`).join('、')
      : materials[task.materialId]?.name ?? task.materialId;
    const domainName = task.domainName ?? materials[task.materialId]?.domainName;
    log.info('[候选任务] {name} | 类型={type} | 目标={target} | 缺口={shortage} | 状态={status}',
      name, task.executionType, domainName ?? '未配置', task.shortage, task.status);
  }
  log.info('[调度] 今日可执行队列：{queue}', JSON.stringify(plan.todayQueue));
  for (const day of plan.weeklyStrategy) {
    log.info('[周循环] {day}：{tasks}', day.label, day.tasks.map((task) => task.domainName ?? task.materialName).join('、'));
  }
  log.info('[调度] 人工待办：{manual}', JSON.stringify(plan.manualItems));
  let history = [];
  try {
    history = JSON.parse(file.readTextSync('record/history.json'));
  } catch {
    // 首次运行没有历史文件属于正常情况。
  }
  const estimate = buildCompletionEstimate({ plan, history, materials, today });
  plan.estimate = estimate;
  log.info('[预估] {message}', Number.isFinite(estimate.days)
    ? `约 ${estimate.days} 天；${estimate.reason}`
    : `暂无法估算；${estimate.reason}`);
  await file.writeText('record/latest-plan.json', JSON.stringify(plan, null, 2), false);
  const runRecord = buildRunRecord({
    executionEnabled,
    plan,
    inventoryBefore: inventoryBeforeExecution,
    inventoryAfter: inventory,
    execution: plan.execution,
    domainResinPolicy,
  });
  const updatedHistory = appendRunHistory(history, runRecord);
  await file.writeText('record/history.json', JSON.stringify(updatedHistory, null, 2), false);
  log.info('[记录] 已保存本次运行记录；历史保留 {count} 条', updatedHistory.length);
  if (settings.sendRunSummary === true) {
    const summary = buildRunSummary(plan, materials, {
      executionEnabled,
      execution: plan.execution,
      estimateDays: estimate.days,
      estimateReason: estimate.reason,
    });
    notification.Send(summary);
    log.info('[通知] 已请求 BetterGI 发送运行摘要；请在 BetterGI 通知设置中启用 JS 通知与邮件通知');
  }
  log.info('[完成] 已保存计划记录：record/latest-plan.json；{result}', executionEnabled ? '本次已执行至多一个已验证秘境任务' : '本次未执行培养或刷取任务');
}

function loadTargets(scriptSettings, rulebook) {
  if (scriptSettings.targetsText?.trim()) {
    const targets = parseTargetText(scriptSettings.targetsText, rulebook);
    log.info('[初始化] 使用设置页目标文本，共解析 {count} 项', targets.length);
    return { targets, inventory: {} };
  }
  const targetFile = scriptSettings.targetFile || 'data/user-targets.json';
  log.info('[初始化] 读取高级目标文件：{path}', targetFile);
  return JSON.parse(file.readTextSync(targetFile));
}

async function executeFirstResinTask(plan, settings, resinPolicy, materials, inventory) {
  const task = plan.todayQueue.find((item) => item.status === 'supported');
  if (!task) {
    log.info('[执行] 今日没有已验证的树脂任务，本次不执行');
    return { status: 'skipped', reason: '今日没有已验证的树脂任务', rewards: {}, appliedGains: false };
  }
  if (task.executionType === 'weeklyBoss') return executeWeeklyBossTask(task, settings, materials, inventory);
  if (task.executionType === 'boss') return executeBossTask(task, settings, inventory);
  if (task.executionType !== 'domain') {
    return { status: 'skipped', reason: `暂不支持执行任务类型：${task.executionType}`, rewards: {}, appliedGains: false };
  }

  const config = buildDomainExecutionConfig(task, settings, resinPolicy);
  log.info('[执行] 准备刷取秘境“{domain}”，材料目标：{materials}', config.domainName,
    config.trackedMaterials.map((item) => `${item.materialName}×${item.shortage}`).join('、'));

  log.info('[执行] 不合成树脂，直接按“浓缩树脂 → 原粹树脂”的优先级领取奖励');

  const switched = await genshin.SwitchParty(config.partyName);
  if (!switched) {
    throw new Error(`切换秘境队伍失败：${config.partyName}`);
  }
  log.info('[执行] 已切换秘境队伍，传送七天神像恢复后再进入秘境');
  await genshin.TpToStatueOfTheSeven();

  const param = new AutoDomainParam(0);
  param.DomainName = config.domainName;
  param.PartyName = config.partyName;
  if (config.sundaySelectedValue) param.SundaySelectedValue = config.sundaySelectedValue;
  if (config.strategyName) param.CombatStrategyPath = param.SetCombatStrategyPath(config.strategyName);
  param.SpecifyResinUse = config.resinPolicy.specifyResinUse;
  param.OriginalResinUseCount = config.resinPolicy.originalResinUseCount;
  param.CondensedResinUseCount = config.resinPolicy.condensedResinUseCount;
  param.TransientResinUseCount = config.resinPolicy.transientResinUseCount;
  param.FragileResinUseCount = config.resinPolicy.fragileResinUseCount;
  param.RewardRecognitionEnabled = true;

  const rewards = normalizeRewardMap(await dispatcher.RunAutoDomainTask(param));
  const trackedNames = new Set(config.trackedMaterials.map((item) => item.materialName));
  const trackedRewards = Object.fromEntries(Object.entries(rewards).filter(([name]) => trackedNames.has(name)));
  if (Object.keys(rewards).length === 0) {
    log.warn('[执行] BetterGI 未识别到奖励；本次已刷取但无法统计实际掉落，将在摘要中明确标记');
  }
  log.info('[执行] 秘境“{domain}”完成，识别到目标材料奖励：{rewards}', config.domainName, JSON.stringify(trackedRewards));
  return {
    status: 'completed',
    task,
    rewards,
    trackedRewards,
    rewardRecognitionFailed: Object.keys(rewards).length === 0,
    appliedGains: Object.keys(rewards).length > 0,
    inventoryBefore: inventory,
  };
}

async function executeWeeklyBossTask(task, scriptSettings, materials, inventory) {
  const config = buildWeeklyBossExecutionConfig(task, scriptSettings);
  log.info('[周本] 准备刷取“{domain}”，材料目标：{materials}', config.domainName,
    config.trackedMaterials.map((item) => `${item.materialName}×${item.shortage}`).join('、'));
  const switched = await genshin.SwitchParty(config.partyName);
  if (!switched) throw new Error(`切换周本队伍失败：${config.partyName}`);
  await genshin.TpToStatueOfTheSeven();
  const param = new AutoDomainParam(0);
  param.DomainName = config.domainName;
  param.PartyName = config.partyName;
  if (config.strategyName) param.CombatStrategyPath = param.SetCombatStrategyPath(config.strategyName);
  param.SpecifyResinUse = true;
  param.SetResinPriorityList('原粹树脂');
  param.OriginalResinUseCount = config.originalResinUseCount;
  param.CondensedResinUseCount = 0;
  param.TransientResinUseCount = 0;
  param.FragileResinUseCount = 0;
  param.RewardRecognitionEnabled = true;
  const rewards = normalizeRewardMap(await dispatcher.RunAutoDomainTask(param));
  const trackedNames = new Set(config.trackedMaterials.map((item) => item.materialName));
  const trackedRewards = Object.fromEntries(Object.entries(rewards).filter(([name]) => trackedNames.has(name)));
  return {
    status: 'completed', task, rewards, trackedRewards,
    rewardRecognitionFailed: Object.keys(rewards).length === 0,
    appliedGains: Object.keys(trackedRewards).length > 0,
    inventoryBefore: inventory,
  };
}

async function executeBossTask(task, scriptSettings, inventory) {
  const config = buildBossExecutionConfig(task, scriptSettings);
  log.info('[Boss] 准备刷取“{boss}”，材料目标：{materials}', config.bossName,
    config.trackedMaterials.map((item) => `${item.materialName}×${item.shortage}`).join('、'));
  const switched = await genshin.SwitchParty(config.partyName);
  if (!switched) throw new Error(`切换 Boss 队伍失败：${config.partyName}`);
  await genshin.TpToStatueOfTheSeven();
  const param = new AutoBossParam();
  param.BossName = config.bossName;
  param.TeamName = config.partyName;
  if (config.strategyName) param.StrategyName = config.strategyName;
  param.SpecifyRunCount = false;
  param.RunCount = config.runCount;
  param.UseTransientResin = false;
  param.UseFragileResin = false;
  param.ReviveRetryCount = config.reviveRetryCount;
  param.ReturnToStatueAfterEachRound = false;
  param.RewardRecognitionEnabled = true;
  const rewards = normalizeRewardMap(await dispatcher.RunAutoBossTask(param));
  const trackedNames = new Set(config.trackedMaterials.map((item) => item.materialName));
  const trackedRewards = Object.fromEntries(Object.entries(rewards).filter(([name]) => trackedNames.has(name)));
  if (Object.keys(rewards).length === 0) {
    log.warn('[Boss] BetterGI 未识别到奖励；将以执行后背包差值作为最终统计依据');
  }
  return {
    status: 'completed', task, rewards, trackedRewards,
    rewardRecognitionFailed: Object.keys(rewards).length === 0,
    appliedGains: Object.keys(trackedRewards).length > 0,
    inventoryBefore: inventory,
  };
}

function getTrackedMaterialIds(task) {
  return task.materials?.map((item) => item.materialId) ?? [task.materialId];
}

async function executeMatchedRoutes(routes, scriptSettings, inventory, materials) {
  const routePlan = buildRouteExecutionPlan(routes, scriptSettings);
  let currentInventory = inventory;
  let currentParty = '';
  const gains = {};
  const records = [];
  for (const route of routePlan) {
    if (currentParty !== route.partyName) {
      const switched = await genshin.SwitchParty(route.partyName);
      if (!switched) throw new Error(`切换路线队伍失败：${route.partyName}`);
      currentParty = route.partyName;
      log.info('[路线执行] 已切换{type}队伍：{party}', route.type === 'localSpecialty' ? '采集' : '怪物材料', currentParty);
    }
    let gained = 0;
    const routeRecord = { materialId: route.materialId, name: route.name, type: route.type, paths: [], gained: 0 };
    for (const routePath of route.paths) {
      const before = currentInventory[route.materialId];
      log.info('[路线执行] 开始“{name}”：{path}', route.name, routePath);
      await pathingScript.runFile(routePath);
      currentInventory = await scanInventoryItemIds([route.materialId], currentInventory, materials, `路线“${route.name}”后`);
      const after = currentInventory[route.materialId];
      const delta = Number.isInteger(before) && Number.isInteger(after) ? Math.max(0, after - before) : 0;
      gained += delta;
      routeRecord.paths.push({ path: routePath, gain: delta });
      log.info('[路线执行] “{name}”路线完成，确认收益：{gain}；累计：{total}/{shortage}', route.name, delta, gained, route.shortage);
      if (gained >= route.shortage) break;
    }
    routeRecord.gained = gained;
    records.push(routeRecord);
    if (gained > 0) gains[route.name] = (gains[route.name] ?? 0) + gained;
  }
  return { inventory: currentInventory, gains, records };
}

function normalizeRewardMap(rawRewards) {
  if (!rawRewards) return {};
  const entries = Object.entries(rawRewards);
  if (entries.length > 0) return Object.fromEntries(entries);
  // ClearScript 对 .NET Dictionary 的枚举方式随版本不同，此分支兼容 Keys 属性。
  if (rawRewards.Keys) {
    const result = {};
    for (const key of rawRewards.Keys) result[String(key)] = Number(rawRewards[key]) || 0;
    return result;
  }
  return {};
}

async function scanInventoryMaterials(plan, inventory, materials, phase) {
  return scanInventoryItemIds(plan.crafting.scanMaterialIds, inventory, materials, phase);
}

async function scanInventoryItemIds(materialIds, inventory, materials, phase) {
  const scanGroups = buildInventoryScanGroups(materialIds, materials);
  const scanCount = Object.values(scanGroups).reduce((total, items) => total + items.length, 0);
  let updatedInventory = inventory;
  log.info('[背包] {phase}读取 {count} 个本次目标材料及可合成低阶材料', phase, scanCount);
  for (const [tabName, scanItems] of Object.entries(scanGroups)) {
    const param = new CountInventoryItemParam();
    param.GridScreenName = tabName === 'CharacterDevelopmentItems'
      ? GridScreenName.CharacterDevelopmentItems
      : GridScreenName.Materials;
    for (const item of scanItems) param.ItemNames.Add(item.name);
    try {
      log.info('[背包] {phase}读取“{tab}”页：{names}', phase, tabName, scanItems.map((item) => item.name).join('、'));
      const counts = await dispatcher.RunCountInventoryItemTask(param);
      const applied = applyInventoryScanResult(updatedInventory, scanItems, counts);
      updatedInventory = applied.inventory;
      if (applied.failedNames.length > 0) {
        log.warn('[背包] {phase}以下材料 OCR 失败，将不用于收益统计：{names}', phase, applied.failedNames.join('、'));
      }
    } catch (error) {
      log.error('[背包] {phase}读取“{tab}”页失败，相关材料将保留原值：{error}', phase, tabName, error.message ?? String(error));
    }
  }
  return updatedInventory;
}

function isExecutionEnabled(planOnlyValue) {
  // BetterGI 不同版本可能把 checkbox 值传为布尔、数字或字符串。
  return planOnlyValue === false || planOnlyValue === 0 || planOnlyValue === 'false' || planOnlyValue === '0';
}

await main();
