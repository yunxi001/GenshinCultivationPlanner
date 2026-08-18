import test from 'node:test';
import assert from 'node:assert/strict';
import { runBossTaskWithSafeExit } from '../core/boss-safety.js';

function createLogger() {
  return { info() {}, warn() {} };
}

test('Boss 正常结束后传送七天神像并保留任务返回值', async () => {
  let teleported = false;
  const rewards = { 承光的鳞羽: 12 };
  const result = await runBossTaskWithSafeExit({
    runTask: async () => rewards,
    teleportToStatue: async () => { teleported = true; },
    logger: createLogger(),
  });
  assert.equal(teleported, true);
  assert.equal(result, rewards);
});

test('Boss 抛出异常时仍尝试安全退场且保留原始异常', async () => {
  let teleported = false;
  const taskError = new Error('自动首领执行失败');
  await assert.rejects(() => runBossTaskWithSafeExit({
    runTask: async () => { throw taskError; },
    teleportToStatue: async () => { teleported = true; },
    logger: createLogger(),
  }), (error) => error === taskError);
  assert.equal(teleported, true);
});

test('安全退场失败时不覆盖已完成的 Boss 结果', async () => {
  let warningCount = 0;
  const result = await runBossTaskWithSafeExit({
    runTask: async () => ({ 承光的鳞羽: 3 }),
    teleportToStatue: async () => { throw new Error('传送失败'); },
    logger: { info() {}, warn() { warningCount += 1; } },
  });
  assert.deepEqual(result, { 承光的鳞羽: 3 });
  assert.equal(warningCount, 1);
});
