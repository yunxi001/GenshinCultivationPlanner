import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCompletionEstimate } from '../core/estimate.js';
import { buildRunSummary } from '../core/report.js';

const routePath = '地方特产/须弥/月莲/01-月莲.json';
const plan = {
  displayShortages: [{
    materialId: 'lotus', shortage: 20,
    material: { name: '月莲', status: 'supported', executionType: 'route' },
  }],
  routes: { matched: [{ materialId: 'lotus', name: '月莲', type: 'localSpecialty', paths: [routePath] }] },
};

function routeRun(day, gained, { status = 'completed', path = routePath, actualGain = gained } = {}) {
  return {
    timestamp: `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    inventoryBefore: { lotus: 2 },
    inventoryAfter: { lotus: 2 + actualGain },
    execution: { inventoryObservedAfter: { lotus: 2 + actualGain }, routes: [{
      type: 'localSpecialty', status, paths: [{ path }],
      materials: [{ materialId: 'lotus', name: '月莲', gained }],
    }] },
  };
}

test('路线按三次确认收益和实际运行间隔预估次数与天数', () => {
  const estimate = buildCompletionEstimate({
    plan, materials: {}, today: 4,
    history: [routeRun(1, 4), routeRun(3, 6), routeRun(5, 5)],
  });
  assert.equal(estimate.days, 8);
  assert.equal(estimate.details[0].sampleCount, 3);
  assert.equal(estimate.details[0].averageBaseYield, 5);
  assert.equal(estimate.details[0].cadenceDays, 2);
  assert.equal(estimate.details[0].estimatedRuns, 4);
  const message = buildRunSummary({ ...plan, todayQueue: [], weeklyStrategy: [] }, { lotus: { name: '月莲' } }, {
    estimateDays: estimate.days, estimateReason: estimate.reason, estimateDetails: estimate.details,
  });
  assert.match(message, /月莲约需4次路线运行、约8天/);
});

test('样本不足、关闭路线和不同路线文件都不能虚构预计天数', () => {
  const history = [routeRun(1, 4), routeRun(3, 6), routeRun(5, 9, { path: '地方特产/须弥/月莲/其他.json' })];
  const missingSample = buildCompletionEstimate({ plan, materials: {}, today: 4, history });
  assert.equal(missingSample.days, null);
  assert.match(missingSample.reason, /2\/3 次/);
  const disabled = buildCompletionEstimate({ plan, materials: {}, today: 4,
    history: [...history, routeRun(7, 5)], routeExecutionEnabled: false });
  assert.equal(disabled.days, null);
  assert.match(disabled.reason, /路线执行未启用/);
});

test('背包差值不一致或同次两组路线都产出同材料时跳过污染样本', () => {
  const duplicated = routeRun(7, 5);
  duplicated.execution.routes.push({ ...duplicated.execution.routes[0], paths: [{ path: '另一条路线.json' }] });
  const estimate = buildCompletionEstimate({
    plan, materials: {}, today: 4,
    history: [routeRun(1, 4), routeRun(3, 6), routeRun(5, 5, { actualGain: 1 }), duplicated],
  });
  assert.equal(estimate.days, null);
  assert.match(estimate.reason, /2\/3 次/);
});

test('任务奖励兜底修正的最终库存不能充当路线背包收益', () => {
  const fallback = routeRun(5, 5, { actualGain: 0 });
  fallback.inventoryAfter.lotus = 7;
  const estimate = buildCompletionEstimate({
    plan, materials: {}, today: 4,
    history: [routeRun(1, 4), routeRun(3, 6), fallback],
  });
  assert.equal(estimate.days, null);
  assert.match(estimate.reason, /2\/3 次/);
});

test('同一合成链按低阶等价值统计路线收益', () => {
  const recipes = { mid: { resultCount: 1, inputs: [{ id: 'low', count: 3 }] } };
  const chainPlan = {
    displayShortages: [{ materialId: 'mid', shortage: 4,
      material: { name: '中阶材料', status: 'supported', executionType: 'route' } }],
    routes: { matched: [{ materialId: 'mid', name: '中阶材料', type: 'monster', paths: ['敌人与魔物/测试/作者/01.json'] }] },
  };
  const history = [1, 2, 3].map((day) => ({
    timestamp: `2026-09-0${day}T12:00:00.000Z`,
    inventoryBefore: { low: 0, mid: 0 },
    inventoryAfter: { low: 3, mid: 1 },
    execution: { inventoryObservedAfter: { low: 3, mid: 1 }, routes: [{ status: 'completed', type: 'monster',
      paths: [{ path: '敌人与魔物/测试/作者/01.json' }],
      materials: [
        { materialId: 'low', gained: 3 },
        { materialId: 'mid', gained: 1 },
      ],
    }] },
  }));
  const estimate = buildCompletionEstimate({ plan: chainPlan, history, materials: {}, recipes, today: 4 });
  assert.equal(estimate.details[0].baseShortage, 12);
  assert.equal(estimate.details[0].averageBaseYield, 6);
  assert.equal(estimate.details[0].estimatedRuns, 2);
});
