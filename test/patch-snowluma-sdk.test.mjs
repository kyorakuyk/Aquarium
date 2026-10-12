import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patchScript = path.join(repoRoot, 'scripts', 'patch-snowluma-sdk.mjs');

test('补齐 SDK 的 JS 与声明文件相对导入且可重复运行', (t) => {
  assert.ok(fs.existsSync(patchScript), 'SDK 修补脚本应存在');

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-patch-sdk-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const scriptPath = path.join(fixtureRoot, 'scripts', 'patch-snowluma-sdk.mjs');
  const distRoot = path.join(fixtureRoot, 'node_modules', '@snowluma', 'sdk', 'dist');
  const otherPackageRoot = path.join(fixtureRoot, 'node_modules', '@other', 'pkg', 'dist');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(path.join(distRoot, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(distRoot, 'typed-dir'), { recursive: true });
  fs.mkdirSync(otherPackageRoot, { recursive: true });
  fs.copyFileSync(patchScript, scriptPath);

  const jsPath = path.join(distRoot, 'index.js');
  const declarationPath = path.join(distRoot, 'index.d.ts');
  const otherPackagePath = path.join(otherPackageRoot, 'index.js');
  fs.writeFileSync(jsPath, [
    "export { leaf } from './leaf';",
    "export { nested } from './nested';",
    "export { missing } from './missing';",
    "export { already } from './already.js';",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(distRoot, 'leaf.js'), 'export const leaf = true;\n');
  fs.writeFileSync(path.join(distRoot, 'nested', 'index.js'), 'export const nested = true;\n');
  fs.writeFileSync(path.join(distRoot, 'typed-dir', 'index.d.ts'), 'export type Typed = string;\n');
  fs.writeFileSync(path.join(distRoot, 'typed-dir', 'index.js'), 'export const typed = true;\n');
  fs.writeFileSync(path.join(distRoot, 'types.d.ts'), 'export type Types = string;\n');
  fs.writeFileSync(declarationPath, [
    "export type { Types } from './types';",
    "export type { Typed } from './typed-dir';",
    "export type { Missing } from './missing-types';",
    '',
  ].join('\n'));
  fs.writeFileSync(otherPackagePath, "export { other } from './leaf';\n");

  const firstRun = spawnSync(process.execPath, [scriptPath], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
  assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.error?.message);
  assert.equal(fs.readFileSync(jsPath, 'utf8'), [
    "export { leaf } from './leaf.js';",
    "export { nested } from './nested/index.js';",
    "export { missing } from './missing';",
    "export { already } from './already.js';",
    '',
  ].join('\n'));
  assert.equal(fs.readFileSync(declarationPath, 'utf8'), [
    "export type { Types } from './types.js';",
    "export type { Typed } from './typed-dir/index.js';",
    "export type { Missing } from './missing-types';",
    '',
  ].join('\n'));
  assert.equal(fs.readFileSync(otherPackagePath, 'utf8'), "export { other } from './leaf';\n");

  const firstJs = fs.readFileSync(jsPath, 'utf8');
  const firstDeclaration = fs.readFileSync(declarationPath, 'utf8');
  const secondRun = spawnSync(process.execPath, [scriptPath], {
    cwd: fixtureRoot,
    encoding: 'utf8',
  });
  assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.error?.message);
  assert.equal(fs.readFileSync(jsPath, 'utf8'), firstJs);
  assert.equal(fs.readFileSync(declarationPath, 'utf8'), firstDeclaration);
  assert.match(secondRun.stdout, /0 个文件/);
});
