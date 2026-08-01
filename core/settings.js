const ARTIFACT_TEST_PREFIX = '单次｜';
const ARTIFACT_FORMAL_PREFIX = '正式｜';

/** 将紧凑设置页的模式值转换为现有执行器使用的兼容字段。 */
export function normalizeScriptSettings(rawSettings = {}) {
  const normalized = { ...rawSettings };

  applyDomainMode(normalized, rawSettings.domainRunMode);
  applyBossMode(normalized, rawSettings.bossRunMode);
  applyWeeklyMode(normalized, rawSettings.weeklyRunMode);
  applyArtifactMode(normalized, rawSettings.artifactRunMode);
  applyResinStrategy(normalized, rawSettings.resinStrategy);
  applyCombatStrategies(normalized, rawSettings.combatStrategiesText);

  return normalized;
}

function applyDomainMode(settings, mode) {
  if (!hasValue(mode)) return;
  if (mode === '正式运行') settings.domainTestSingleRun = false;
  else if (mode === '单次测试') settings.domainTestSingleRun = true;
  else throw new Error(`未知的培养秘境模式：“${mode}”`);
}

function applyBossMode(settings, mode) {
  if (!hasValue(mode)) return;
  const values = {
    '关闭 Boss': [false, false],
    '单次测试 Boss': [true, true],
    '连续刷取 Boss': [true, false],
  };
  if (!values[mode]) throw new Error(`未知的世界 Boss 模式：“${mode}”`);
  [settings.bossExecutionEnabled, settings.bossTestSingleRun] = values[mode];
}

function applyWeeklyMode(settings, mode) {
  if (!hasValue(mode)) return;
  if (mode === '关闭周本') settings.weeklyBossExecutionEnabled = false;
  else if (mode === '启用周本') settings.weeklyBossExecutionEnabled = true;
  else throw new Error(`未知的周本模式：“${mode}”`);
}

function applyArtifactMode(settings, mode) {
  if (!hasValue(mode)) return;
  if (mode === '关闭圣遗物填充') {
    settings.artifactDomainEnabled = false;
    settings.artifactTestSingleRun = false;
    return;
  }
  const testSingleRun = mode.startsWith(ARTIFACT_TEST_PREFIX);
  const prefix = testSingleRun ? ARTIFACT_TEST_PREFIX : ARTIFACT_FORMAL_PREFIX;
  if (!mode.startsWith(prefix) || mode.length === prefix.length) {
    throw new Error(`未知的圣遗物填充模式：“${mode}”`);
  }
  settings.artifactDomainEnabled = true;
  settings.artifactTestSingleRun = testSingleRun;
  settings.artifactDomainName = mode.slice(prefix.length);
}

function applyResinStrategy(settings, strategy) {
  if (!hasValue(strategy)) return;
  const values = {
    '浓缩→原粹': [true, true, false, false],
    '仅原粹': [false, true, false, false],
    '仅浓缩': [true, false, false, false],
    '浓缩→原粹→须臾': [true, true, true, false],
    '浓缩→原粹→须臾→脆弱': [true, true, true, true],
  };
  if (!values[strategy]) throw new Error(`未知的树脂策略：“${strategy}”`);
  [
    settings.domainUseCondensedResin,
    settings.domainUseOriginalResin,
    settings.domainUseTransientResin,
    settings.domainUseFragileResin,
  ] = values[strategy];
}

function applyCombatStrategies(settings, text) {
  if (!hasValue(text)) return;
  const fieldByKey = {
    '秘境': 'domainCombatStrategyName',
    '培养秘境': 'domainCombatStrategyName',
    'boss': 'bossCombatStrategyName',
    '世界boss': 'bossCombatStrategyName',
    '首领': 'bossCombatStrategyName',
    '周本': 'weeklyBossCombatStrategyName',
    '圣遗物': 'artifactCombatStrategyName',
    '圣遗物秘境': 'artifactCombatStrategyName',
  };
  const assignedFields = new Set();
  const entries = String(text).split(/[；;\r\n]+/).map((item) => item.trim()).filter(Boolean);
  for (const entry of entries) {
    const match = entry.match(/^([^=：:]+?)\s*[=：:]\s*(.+)$/);
    if (!match) throw new Error(`战斗策略格式错误：“${entry}”；应填写“类型=策略名称”`);
    const key = match[1].replaceAll(' ', '').toLowerCase();
    const field = fieldByKey[key];
    if (!field) throw new Error(`未知的战斗策略类型：“${match[1].trim()}”`);
    if (assignedFields.has(field)) throw new Error(`战斗策略类型重复：“${match[1].trim()}”`);
    assignedFields.add(field);
    settings[field] = match[2].trim();
  }
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}
