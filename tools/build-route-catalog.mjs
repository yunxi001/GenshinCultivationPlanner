import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const inputArgs = process.argv.slice(2).filter((value) => value !== '--');
const repoRoot = path.resolve(inputArgs[0] ?? '');
const repoRef = 'origin/main';
if (!inputArgs[0]) throw new Error('请指定 bettergi-scripts-list 本地仓库路径');
const originUrl = git('remote', 'get-url', 'origin').trim();
if (!/github\.com[:/]babalae\/bettergi-scripts-list(?:\.git)?$/i.test(originUrl)) {
  throw new Error('指定仓库的 origin 不是 BetterGI 官方脚本仓库');
}

const candidates = JSON.parse(await fs.readFile(path.join(projectRoot, 'data/source-candidates.json'), 'utf8'));
const materialDefinitions = JSON.parse(await fs.readFile(path.join(projectRoot, 'data/materials.json'), 'utf8'));
for (const [materialId, material] of Object.entries(materialDefinitions)) {
  if (!/^(100|101)/.test(materialId) || !material.name || candidates[materialId]) continue;
  candidates[materialId] = {
    name: material.name,
    type: 'localSpecialty',
    routeNames: [material.name],
  };
}
const revision = git('rev-parse', repoRef).trim();
const trackedFiles = git('ls-tree', '-r', '-z', '--name-only', revision, '--',
  'repo/pathing/地方特产', 'repo/pathing/敌人与魔物')
  .split('\0')
  .filter((file) => file.endsWith('.json') && isSafeRepoPath(file));

const materials = {};
for (const [materialId, candidate] of Object.entries(candidates)) {
  if (!['localSpecialty', 'monster'].includes(candidate.type)) continue;
  const packages = [];
  for (const routeName of candidate.routeNames ?? []) {
    if (!routeName || routeName.includes('/') || routeName.includes('\\')) continue;
    const roots = candidate.type === 'localSpecialty'
      ? [...new Set(trackedFiles
        .filter((file) => file.startsWith('repo/pathing/地方特产/'))
        .map((file) => file.split('/').slice(0, 5).join('/')))]
        .filter((root) => root.endsWith(`/${routeName}`))
      : [`repo/pathing/敌人与魔物/${routeName}`];
    for (const root of roots) {
      const files = trackedFiles.filter((file) => file.startsWith(`${root}/`));
      for (const bundle of collectRouteBundles(root, files)) {
        const variant = bundle.folder === root ? '' : bundle.folder.slice(root.length + 1);
        const repoPaths = bundle.paths;
        const importPaths = repoPaths.map((file) => file.slice('repo/'.length));
        packages.push({
          variant: variant || '默认路线',
          repoPaths: importPaths,
          fileCount: bundle.fileCount,
          importLink: `bettergi://script?import=${encodeURIComponent(Buffer.from(JSON.stringify(importPaths), 'utf8').toString('base64'))}`,
        });
      }
    }
  }
  const deduplicated = [...new Map(packages.map((item) => [item.repoPaths.join('\0'), item])).values()]
    .sort((a, b) => a.repoPaths[0].localeCompare(b.repoPaths[0], 'zh-CN'));
  materials[materialId] = {
    name: candidate.name,
    type: candidate.type,
    routeNames: candidate.routeNames ?? [],
    packages: deduplicated,
  };
}

const catalog = {
  schemaVersion: 1,
  sourceRepository: 'babalae/bettergi-scripts-list',
  sourceRevision: revision,
  dataVersion: JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')).devDependencies['genshin-db'],
  materials,
};
await fs.writeFile(path.join(projectRoot, 'data/route-catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
const available = Object.values(materials).filter((item) => item.packages.length > 0).length;
process.stdout.write(`已生成路线目录：${available}/${Object.keys(materials).length} 种材料有官方路线，来源 ${revision.slice(0, 8)}\n`);

function git(...args) {
  return execFileSync('git', ['-c', `safe.directory=${repoRoot}`, '-C', repoRoot, ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}

function isSafeRepoPath(value) {
  return value.startsWith('repo/pathing/')
    && !value.includes('\\')
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function collectRouteBundles(folder, files) {
  const direct = files.filter((file) => !file.slice(folder.length + 1).includes('/'));
  const children = [...new Set(files
    .filter((file) => file.slice(folder.length + 1).includes('/'))
    .map((file) => file.slice(folder.length + 1).split('/')[0]))];
  const bundles = [];
  if (direct.length > 0) {
    // 目录内同时有子变体时，只导入直属 JSON，避免把其他变体一起订阅。
    bundles.push({ folder, paths: children.length > 0 ? direct : [folder], fileCount: direct.length });
  }
  for (const child of children) {
    const childFolder = `${folder}/${child}`;
    bundles.push(...collectRouteBundles(childFolder, files.filter((file) => file.startsWith(`${childFolder}/`))));
  }
  return bundles;
}
