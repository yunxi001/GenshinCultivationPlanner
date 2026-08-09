import fs from 'node:fs/promises';
import path from 'node:path';
import { buildExecutionPolicy } from '../core/execution-policy.js';
import { normalizeScriptSettings } from '../core/settings.js';

const root = path.resolve(import.meta.dirname, '..');
const settingItems = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
const defaults = Object.fromEntries(settingItems.filter((item) => item.default !== undefined).map((item) => [item.name, item.default]));
const settings = normalizeScriptSettings(defaults);
const policy = buildExecutionPolicy(settings);
console.log('角色一键养成｜执行规则预览');
for (const line of policy.previewLines) console.log(`- ${line}`);
console.log('- 硬约束：执行确认、开放日、真实材料缺口、队伍必填、周日奖励序号、周本手动、Boss 仅原粹树脂均不可被自定义覆盖');
