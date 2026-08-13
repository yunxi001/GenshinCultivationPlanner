import { buildProfileSnapshot } from './profile.js';
import { isAscensionLevel, resolveRecognizedAscension } from './level-state.js';

export const CHARACTER_DEVELOPMENT_CATEGORIES = '属性;武器;天赋';
const CHARACTER_ONLY_CATEGORIES = '属性;天赋';
const ONE_STAR_WEAPONS = new Set(['无锋剑', '训练大剑', '新手长枪', '学徒笔记', '猎弓']);

/** 以实际接口存在性判断能力，避免仅凭 BetterGI 版本号误判。 */
export function detectCharacterDevelopmentCapability(api) {
  const available = Boolean(api)
    && typeof api.GetCharacter === 'function'
    && typeof api.GetMultiCharacters === 'function';
  return {
    available,
    getCharacter: typeof api?.GetCharacter === 'function',
    getMultiCharacters: typeof api?.GetMultiCharacters === 'function',
    reason: available ? '' : '当前 BetterGI 未提供完整的角色养成识别接口（需要 0.63.0 或更高版本）',
  };
}

/** 调用 BetterGI 0.63.0 接口，并转换成现有材料计算目标。 */
export async function loadAutomaticProfile({ api, selections, rulebook, capturedAt }) {
  const capability = detectCharacterDevelopmentCapability(api);
  if (!capability.available) throw new Error(`${capability.reason}；请改用手动档案模式`);
  const names = normalizeCharacterNames(selections?.characterNames);
  if (names.length === 0) throw new Error('自动档案模式至少需要选择一名角色');
  const weaponMode = normalizeWeaponMode(selections?.weaponMode);
  const categories = weaponMode === 'equipped' ? CHARACTER_DEVELOPMENT_CATEGORIES : CHARACTER_ONLY_CATEGORIES;
  const manualWeaponTarget = weaponMode === 'manual'
    ? buildManualWeaponTarget(selections?.manualWeapon, rulebook)
    : null;

  let rawResults;
  try {
    rawResults = names.length === 1
      ? [await api.GetCharacter(names[0], categories)]
      : Array.from(await api.GetMultiCharacters(names, categories));
  } catch (error) {
    throw new Error(`BetterGI 读取角色养成档案失败：${error?.message ?? String(error)}`);
  }
  if (rawResults.length !== names.length) {
    throw new Error(`BetterGI 返回 ${rawResults.length} 份档案，但本次请求了 ${names.length} 名角色`);
  }

  const targets = [];
  const entries = [];
  rawResults.forEach((raw, index) => {
    const converted = convertCharacterResult(raw, names[index], selections, rulebook);
    targets.push(converted.characterTarget);
    if (converted.weaponTarget) targets.push(converted.weaponTarget);
    entries.push(converted.characterEntry);
    if (converted.weaponEntry) entries.push(converted.weaponEntry);
  });
  if (manualWeaponTarget) {
    targets.push(manualWeaponTarget);
    entries.push({ ...manualWeaponTarget, equippedBy: null, ignored: false, ignoreReason: null });
  }
  return {
    targets,
    profileSnapshot: buildProfileSnapshot(targets, {
      source: 'bettergi-character-development',
      capturedAt,
      entries,
    }),
  };
}

export function convertCharacterResult(raw, requestedName, selections, rulebook) {
  if (!raw || typeof raw !== 'object') throw new Error(`角色“${requestedName}”未返回有效档案`);
  if (!rulebook.characters?.[requestedName]) throw new Error(`角色“${requestedName}”不在当前规则库中`);
  const recognizedName = readText(raw, 'CharacterName', 'characterName') || requestedName;
  const currentLevel = readLevel(raw, ['Level', 'level'], `${requestedName}当前等级`, 90);
  const levelLimit = readOptionalLevel(raw, 'LevelLimit', 'levelLimit');
  const currentAscended = resolveRecognizedAscension(currentLevel, levelLimit, `角色“${requestedName}”`);
  const targetLevel = normalizeTarget(selections.characterTargetLevel, currentLevel, 90, '角色目标等级');
  const targetAscended = resolveTargetAscended({
    currentLevel, currentAscended, targetLevel,
    requestedLevel: selections.characterTargetLevel,
    requestedAscended: selections.characterTargetAscended,
  });
  const talentSpecs = [
    ['normal', 'AttackLevel', 'AttackHasBonus', '普通攻击'],
    ['skill', 'SkillLevel', 'SkillHasBonus', '元素战技'],
    ['burst', 'BurstLevel', 'BurstHasBonus', '元素爆发'],
  ];
  const talents = {};
  for (const [key, levelField, bonusField, label] of talentSpecs) {
    const displayed = readLevel(raw, [levelField, lowerFirst(levelField)], `${requestedName}${label}等级`, 15);
    const hasBonus = readBoolean(raw, bonusField, lowerFirst(bonusField));
    const actual = displayed - (hasBonus ? 3 : 0);
    if (actual < 1 || actual > 10) throw new Error(`角色“${requestedName}”${label}换算后的实际等级 ${actual} 无效`);
    const requestedTarget = normalizeOptionalTarget(selections.talentTargets?.[key], label);
    if (requestedTarget == null) continue;
    talents[key] = {
      current: actual,
      target: Math.max(actual, requestedTarget),
      requestedTarget,
      displayedCurrent: displayed,
      hasBonus,
    };
  }
  const characterTarget = {
    kind: 'character', name: requestedName,
    level: { current: currentLevel, target: targetLevel, currentAscended, targetAscended },
    ...(Object.keys(talents).length > 0 ? { talents } : {}),
  };
  const characterEntry = {
    ...characterTarget,
    recognizedName,
    levelLimit,
    talents: Object.keys(talents).length > 0 ? talents : null,
  };

  const weaponMode = normalizeWeaponMode(selections.weaponMode);
  if (weaponMode !== 'equipped') {
    return { characterTarget, weaponTarget: null, characterEntry, weaponEntry: null };
  }

  const weaponName = readText(raw, 'WeaponName', 'weaponName');
  if (!weaponName) throw new Error(`角色“${requestedName}”的佩戴武器名称为空，已拒绝调度`);
  const weaponLevel = readLevel(raw, ['WeaponLevel', 'weaponLevel'], `${weaponName}当前等级`, 90);
  const weaponLevelLimit = readOptionalLevel(raw, 'WeaponLevelLimit', 'weaponLevelLimit');
  const weaponCurrentAscended = resolveRecognizedAscension(weaponLevel, weaponLevelLimit, `武器“${weaponName}”`);
  const weaponTargetLevel = normalizeTarget(selections.weaponTargetLevel, weaponLevel, 90, '武器目标等级');
  const weaponTargetAscended = resolveTargetAscended({
    currentLevel: weaponLevel,
    currentAscended: weaponCurrentAscended,
    targetLevel: weaponTargetLevel,
    requestedLevel: selections.weaponTargetLevel,
    requestedAscended: selections.weaponTargetAscended,
  });
  const isOneStar = rulebook.weapons?.[weaponName]?.rarity === 1 || ONE_STAR_WEAPONS.has(weaponName);
  const weaponEntry = {
    kind: 'weapon', name: weaponName,
    level: {
      current: weaponLevel,
      target: isOneStar ? weaponLevel : weaponTargetLevel,
      currentAscended: weaponCurrentAscended,
      targetAscended: isOneStar ? weaponCurrentAscended : weaponTargetAscended,
    },
    equippedBy: requestedName,
    levelLimit: weaponLevelLimit,
    ignored: isOneStar,
    ignoreReason: isOneStar ? '一星初始武器，已忽略培养' : null,
  };
  if (!isOneStar && !rulebook.weapons?.[weaponName]) {
    throw new Error(`识别到的武器“${weaponName}”不在当前规则库中，已拒绝调度`);
  }
  const weaponTarget = isOneStar ? null : {
    kind: 'weapon', name: weaponName,
    level: {
      current: weaponLevel, target: weaponTargetLevel,
      currentAscended: weaponCurrentAscended, targetAscended: weaponTargetAscended,
    },
    equippedBy: requestedName,
  };
  return { characterTarget, weaponTarget, characterEntry, weaponEntry };
}

function resolveTargetAscended({ currentLevel, currentAscended, targetLevel, requestedLevel, requestedAscended }) {
  if (!isAscensionLevel(targetLevel)) return false;
  if (targetLevel === currentLevel) {
    return currentAscended || (Number(requestedLevel) === currentLevel && requestedAscended === true);
  }
  return requestedAscended === true;
}

function normalizeWeaponMode(value) {
  const mode = value || 'equipped';
  if (!['equipped', 'none', 'manual'].includes(mode)) throw new Error(`未知的自动档案武器模式：“${mode}”`);
  return mode;
}

function buildManualWeaponTarget(value, rulebook) {
  if (!value || typeof value !== 'object') throw new Error('自动档案缺少手动指定的武器');
  const name = String(value.name ?? '').trim();
  if (!name) throw new Error('手动指定的武器名称不能为空');
  if (!rulebook.weapons?.[name]) throw new Error(`手动指定的武器“${name}”不在当前规则库中`);
  const current = readLevel(value.level ?? {}, ['current'], `${name}当前等级`, 90);
  const target = normalizeTarget(value.level?.target, current, 90, '武器目标等级');
  const currentAscended = value.level?.currentAscended === true;
  const targetAscended = target === current
    ? currentAscended || value.level?.targetAscended === true
    : value.level?.targetAscended === true;
  return { kind: 'weapon', name, level: { current, target, currentAscended, targetAscended } };
}

function normalizeCharacterNames(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map((name) => String(name ?? '').trim()).filter(Boolean))];
}

function normalizeTarget(value, current, max, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${label}必须是 1 到 ${max} 的整数`);
  return Math.max(current, parsed);
}

function normalizeOptionalTarget(value, label) {
  if (value === undefined || value === null || value === '' || String(value).startsWith('不培养')) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) throw new Error(`${label}目标等级必须是 1 到 10 的整数`);
  return parsed;
}

function readLevel(raw, fields, label, max) {
  const value = fields.map((field) => raw[field]).find((item) => item !== undefined && item !== null);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${label}识别结果无效：${value ?? '空'}`);
  return parsed;
}

function readOptionalLevel(raw, ...fields) {
  const value = fields.map((field) => raw[field]).find((item) => item !== undefined && item !== null);
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function readText(raw, ...fields) {
  const value = fields.map((field) => raw[field]).find((item) => item !== undefined && item !== null);
  return String(value ?? '').trim();
}

function readBoolean(raw, ...fields) {
  const value = fields.map((field) => raw[field]).find((item) => item !== undefined && item !== null);
  return value === true || value === 1 || value === 'true' || value === '1';
}

function lowerFirst(value) {
  return `${value[0].toLowerCase()}${value.slice(1)}`;
}
