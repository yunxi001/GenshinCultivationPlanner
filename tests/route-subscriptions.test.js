import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildRouteSubscriptionPlan, formatRouteSubscriptionText } from '../core/route-subscriptions.js';
import { buildRunRecord } from '../core/history.js';
import { buildRunSummary } from '../core/report.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../data/route-catalog.json', import.meta.url), 'utf8'));

test('官方目录覆盖月莲、7.1 新特产和多作者蕈兽路线', () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.match(catalog.sourceRevision, /^[0-9a-f]{40}$/);
  assert.ok(catalog.materials['101215'].packages.length > 0);
  assert.ok(catalog.materials['101275'].packages.length > 0);
  assert.ok(catalog.materials['101277'].packages.length > 0);
  assert.ok(catalog.materials['112059'].packages.length > 1);
});

test('只为实际仍缺且未安装的材料生成建议，多路线版本保留选择', () => {
  const result = buildRouteSubscriptionPlan({
    matched: [{ materialId: '101215', name: '月莲', type: 'localSpecialty', paths: ['地方特产/须弥/月莲/01.json'] }],
    missing: [
      { materialId: '112059', name: '蕈兽孢子', type: 'monster', shortage: 9 },
      { materialId: '101275', name: '霜仙花', type: 'localSpecialty', shortage: 4 },
      { materialId: '101277', name: '金蕨', type: 'localSpecialty', shortage: 0 },
      { materialId: 'unknown', name: '未知材料', type: 'monster', shortage: 2 },
    ],
  }, catalog);
  assert.equal(result.installed.length, 1);
  assert.deepEqual(result.available.map((item) => item.name), ['蕈兽孢子', '霜仙花']);
  assert.equal(result.available[0].requiresChoice, true);
  assert.equal(result.available[1].requiresChoice, false);
  assert.deepEqual(result.unavailable.map((item) => item.name), ['未知材料']);
  const text = formatRouteSubscriptionText(result);
  assert.match(text, /多作者|多个版本/);
  assert.match(text, /bettergi:\/\/script\?import=/);
  assert.doesNotMatch(text, /金蕨/);
  const plan = { routeSubscriptions: result, todayQueue: [], displayShortages: [], weeklyStrategy: [] };
  assert.match(buildRunSummary(plan, {}), /待准备路线/);
  const record = buildRunRecord({ plan, inventoryBefore: {}, inventoryAfter: {}, execution: null });
  assert.equal(record.routeSubscriptions.available[0].variantCount, result.available[0].packages.length);
});

test('全部导入链接能解码为安全的官方 pathing 相对路径', () => {
  for (const material of Object.values(catalog.materials)) {
    for (const routePackage of material.packages) {
      const encoded = routePackage.importLink.split('import=')[1];
      const paths = JSON.parse(Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8'));
      assert.deepEqual(paths, routePackage.repoPaths);
      assert.ok(paths.every((value) => value.startsWith('pathing/')
        && !value.includes('\\') && value.split('/').every((part) => part && part !== '..' && part !== '.')));
    }
  }
});

test('不可信或不匹配的目录条目不能产生订阅链接', () => {
  const invalid = {
    sourceRevision: 'test',
    materials: {
      mid: { name: '测试材料', type: 'monster', packages: [{
        variant: '危险路径', repoPaths: ['pathing/敌人与魔物/../../js/other'], importLink: 'bettergi://script?import=invalid',
      }] },
    },
  };
  const result = buildRouteSubscriptionPlan({
    missing: [{ materialId: 'mid', name: '测试材料', type: 'monster', shortage: 2 }],
  }, invalid);
  assert.equal(result.available.length, 0);
  assert.equal(result.unavailable.length, 1);
});
