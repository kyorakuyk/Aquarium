// 基于 qq-bridge/scripts/patch-snowluma-sdk.mjs（MIT）改写，版权归原作者所有。
// 仅修补 @snowluma/sdk 的 dist ESM 相对导入，供 Node 原生 ESM 解析。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(root, 'node_modules', '@snowluma', 'sdk', 'dist');

function walk(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (entry.isFile() && (fullPath.endsWith('.js') || fullPath.endsWith('.d.ts'))) {
      files.push(fullPath);
    }
  }
  return files;
}

function repairedSpecifier(file, specifier) {
  if (specifier.endsWith('.js') || specifier.endsWith('.json') || specifier.endsWith('.d.ts')) {
    return specifier;
  }

  const declarationFile = file.endsWith('.d.ts');
  const sibling = path.resolve(path.dirname(file), `${specifier}${declarationFile ? '.d.ts' : '.js'}`);
  if (fs.existsSync(sibling)) return `${specifier}.js`;

  const indexFile = path.resolve(path.dirname(file), specifier, 'index.js');
  if (fs.existsSync(indexFile)) return `${specifier}/index.js`;

  return specifier;
}

if (!fs.existsSync(distRoot)) {
  throw new Error(`@snowluma/sdk dist 不存在：${distRoot}`);
}

let patchedFiles = 0;
for (const file of walk(distRoot)) {
  const source = fs.readFileSync(file, 'utf8');
  const repaired = source.replace(/from\s+'(\.[^']+)'/g, (match, specifier) => {
    const nextSpecifier = repairedSpecifier(file, specifier);
    return nextSpecifier === specifier ? match : match.replace(specifier, nextSpecifier);
  });

  if (repaired !== source) {
    fs.writeFileSync(file, repaired);
    patchedFiles += 1;
  }
}

console.log(`[patch-snowluma-sdk] 修补了 ${patchedFiles} 个文件`);
