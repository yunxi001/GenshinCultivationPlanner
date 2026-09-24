import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const rulebook = readJson('../data/rulebook.json');
const materials = readJson('../data/materials.json');
const identities = readJson('../guide-reader/data/guide-identities.json');

test('规则库全部角色与武器成本都有对应材料定义', () => {
  for (const [kind, entries] of [['角色', rulebook.characters], ['武器', rulebook.weapons]]) {
    for (const [name, entry] of Object.entries(entries)) {
      const stages = { ...(entry.ascensionCosts ?? {}), ...(entry.talentCosts ?? {}) };
      for (const [stage, costs] of Object.entries(stages)) {
        for (const cost of costs) {
          assert.ok(Object.hasOwn(materials, String(cost.id)), `${kind}“${name}”${stage}缺少材料 ${cost.name}(${cost.id})`);
        }
      }
    }
  }
});

test('指南身份表排除数据库内部占位角色并覆盖正式角色', () => {
  assert.equal(Object.hasOwn(identities.characters, '奇偶·女性'), false);
  assert.equal(Object.hasOwn(identities.characters, '奇偶·男性'), false);
  for (const [name, identity] of Object.entries(identities.characters)) {
    if (identity.talentIdentity === 'ambiguous-traveler-element') continue;
    assert.ok(Object.hasOwn(rulebook.characters, name), `指南身份“${name}”不在规则库中`);
  }
});

test('当前未自动适配的 Boss 材料保持手动，不会进入自动执行队列', () => {
  for (const materialId of ['113090', '113092']) {
    assert.equal(materials[materialId]?.status, 'manual');
    assert.equal(materials[materialId]?.executionType, 'boss');
    assert.match(materials[materialId]?.reason, /BetterGI 0\.6[45]/);
  }
});
