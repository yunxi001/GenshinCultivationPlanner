import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRewardMap, reconcileRewardEvidence } from '../core/rewards.js';

const materials = {
  low: { name: '「浪迹」的教导' },
  mid: { name: '「浪迹」的指引' },
  high: { name: '「浪迹」的哲学' },
  boss: { name: '堕天的落羽' },
};

test('奖励字典兼容普通对象和 ClearScript Keys 形式', () => {
  assert.deepEqual(normalizeRewardMap({ 摩拉: 8000, 堕天的落羽: 12 }), { 摩拉: 8000, 堕天的落羽: 12 });
  const dictionary = {};
  Object.defineProperty(dictionary, 'Keys', { value: ['堕天的落羽'], enumerable: false });
  Object.defineProperty(dictionary, '堕天的落羽', { value: 12, enumerable: false });
  assert.deepEqual(normalizeRewardMap(dictionary), { 堕天的落羽: 12 });
});

test('背包结果可信时优先使用背包且不重复累计任务奖励', () => {
  const result = reconcileRewardEvidence({
    inventoryBefore: { boss: 2 },
    inventoryAfter: { boss: 5 },
    trackedMaterialIds: ['boss'],
    materials,
    taskRecognizedRewards: { 堕天的落羽: 3 },
    taskExecutionType: 'boss',
  });
  assert.deepEqual(result.trackedRewards, { 堕天的落羽: 3 });
  assert.deepEqual(result.gainSources, { 堕天的落羽: 'inventory' });
  assert.deepEqual(result.rewardDiscrepancies, []);
});

test('背包漏识别时使用任务奖励兜底并更新库存', () => {
  const result = reconcileRewardEvidence({
    inventoryBefore: { boss: 0 },
    inventoryAfter: { boss: 0 },
    trackedMaterialIds: ['boss'],
    materials,
    inventoryIssueNames: ['堕天的落羽'],
    taskRecognizedRewards: { 堕天的落羽: 12, 摩拉: 32000 },
    taskExecutionType: 'boss',
  });
  assert.equal(result.inventory.boss, 12);
  assert.deepEqual(result.trackedRewards, { 堕天的落羽: 12 });
  assert.deepEqual(result.gainSources, { 堕天的落羽: 'task-recognition' });
  assert.deepEqual(result.taskTrackedRewards, { 堕天的落羽: 12 });
  assert.equal(20 - result.trackedRewards.堕天的落羽, 8);
});

test('背包与任务奖励冲突时保留背包结果并记录差异', () => {
  const result = reconcileRewardEvidence({
    inventoryBefore: { boss: 2 },
    inventoryAfter: { boss: 6 },
    trackedMaterialIds: ['boss'],
    materials,
    taskRecognizedRewards: { 堕天的落羽: 3 },
    taskExecutionType: 'boss',
  });
  assert.deepEqual(result.trackedRewards, { 堕天的落羽: 4 });
  assert.deepEqual(result.rewardDiscrepancies, [{ name: '堕天的落羽', inventoryGain: 4, taskGain: 3, selected: 'inventory' }]);
});

test('培养秘境保留同系列各等级奖励并忽略非目标奖励', () => {
  const result = reconcileRewardEvidence({
    inventoryBefore: { low: 0, mid: 0, high: 0 },
    inventoryAfter: { low: 0, mid: 0, high: 0 },
    trackedMaterialIds: ['low', 'mid', 'high'],
    materials,
    inventoryIssueNames: ['「浪迹」的教导', '「浪迹」的指引', '「浪迹」的哲学'],
    taskRecognizedRewards: { '「浪迹」的教导': 4, '「浪迹」的指引': 2, '「浪迹」的哲学': 1, 摩拉: 5000 },
    taskExecutionType: 'domain',
  });
  assert.deepEqual(result.trackedRewards, {
    '「浪迹」的教导': 4,
    '「浪迹」的指引': 2,
    '「浪迹」的哲学': 1,
  });
});

test('圣遗物秘境奖励不进入培养材料收益', () => {
  const result = reconcileRewardEvidence({
    inventoryBefore: { boss: 0 },
    inventoryAfter: { boss: 0 },
    trackedMaterialIds: ['boss'],
    materials,
    inventoryIssueNames: ['堕天的落羽'],
    taskRecognizedRewards: { 堕天的落羽: 3 },
    taskExecutionType: 'artifactDomain',
  });
  assert.deepEqual(result.trackedRewards, {});
  assert.equal(result.inventory.boss, 0);
});
