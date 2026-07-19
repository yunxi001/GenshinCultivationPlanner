import fs from 'node:fs/promises';
import path from 'node:path';
import { createPlan } from '../core/planner.js';

const root = path.resolve(import.meta.dirname, '..');
const targetPath = process.argv[2] ?? path.join(root, 'data', 'demo-targets.json');
const [targetData, materials, recipes, rulebook] = await Promise.all([
  readJson(targetPath),
  readJson(path.join(root, 'data', 'materials.json')),
  readJson(path.join(root, 'data', 'crafting-recipes.json')),
  readJson(path.join(root, 'data', 'rulebook.json')),
]);

console.log(`[初始化] 读取目标文件：${targetPath}`);
console.log(`[初始化] 目标数量：${targetData.targets?.length ?? 0}`);
for (const target of targetData.targets ?? []) {
  console.log(`[目标] ${target.kind}：${target.name}`);
}

const plan = createPlan({
  targets: targetData.targets ?? [],
  inventory: targetData.inventory ?? {},
  materials,
  recipes,
  rulebook,
  today: 0,
});

console.log(`[计算] 材料种类：${plan.shortages.length}`);
console.log(`[调度] 今日队列：${plan.todayQueue.length} 项；人工待办：${plan.manualItems.length} 项`);
for (const craft of plan.crafting.craftPlan) {
  console.log(`[合成] ${materials[craft.materialId]?.name ?? craft.materialId} ×${craft.craftCount}`);
}
for (const item of plan.shortages) {
  const name = item.material?.name ?? item.materialId;
  const owned = item.owned ?? '未确认';
  const shortage = item.shortage ?? '不计算';
  console.log(`[材料] ${name} | 需求=${item.required} | 库存=${owned} | 缺口=${shortage} | 状态=${item.status} | 原因=${item.reason ?? '无'}`);
}

console.log('[完成] 本次为计划模式试运行，未调用任何 BetterGI 游戏任务。');

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}
