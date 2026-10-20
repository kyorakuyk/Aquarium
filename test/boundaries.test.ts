import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repoRoot, 'scripts', 'check-boundaries.mjs');

function createFixture(t: { after(callback: () => void): void }): string {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-boundaries-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  return fixtureRoot;
}

function writeSource(root: string, relativePath: string, source: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
}

function runChecker(cwd: string) {
  return spawnSync(process.execPath, [checker], { cwd, encoding: 'utf8' });
}

test('允许 HANDOFF 规定的依赖方向', (t) => {
  assert.ok(fs.existsSync(checker), '边界检查脚本应存在');
  const fixtureRoot = createFixture(t);
  writeSource(fixtureRoot, 'src/core/pipeline.ts', "import type { ProtocolAdapter } from '../adapters/types.ts';\nimport { loadConfig } from '../config/load.ts';\n");
  writeSource(fixtureRoot, 'src/adapters/types.ts', "import type { IncomingMessage } from '../core/events.ts';\n");
  writeSource(fixtureRoot, 'src/adapters/onebot/adapter.ts', "import type { ProtocolAdapter } from '../types.ts';\nimport type { IncomingMessage } from '../../core/events.ts';\nimport { text } from '@snowluma/sdk';\n");
  writeSource(fixtureRoot, 'src/host/windows/host.ts', "import type { Host } from '../types.ts';\n");

  const result = runChecker(fixtureRoot);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.match(result.stdout, /依赖边界检查通过/);
});

test('拒绝 core、host 与 SDK 的越界导入并指出文件', (t) => {
  assert.ok(fs.existsSync(checker), '边界检查脚本应存在');
  const fixtureRoot = createFixture(t);
  writeSource(fixtureRoot, 'src/core/onebot.ts', "import '../adapters/onebot/adapter.ts';\n");
  writeSource(fixtureRoot, 'src/core/process.ts', "const child = await import('node:child_process');\n");
  writeSource(fixtureRoot, 'src/core/windows.ts', "import '../host/windows/process.ts';\n");
  writeSource(fixtureRoot, 'src/host/windows/host.ts', "import '../../core/events.ts';\n");
  writeSource(fixtureRoot, 'src/app/main.ts', "import { text } from '@snowluma/sdk';\n");

  const result = runChecker(fixtureRoot);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output || result.error?.message);
  assert.match(output, /src\/core\/onebot\.ts.*adapters\/onebot/);
  assert.match(output, /src\/core\/process\.ts.*node:child_process/);
  assert.match(output, /src\/core\/windows\.ts.*host\/windows/);
  assert.match(output, /src\/host\/windows\/host\.ts.*core\/events/);
  assert.match(output, /src\/app\/main\.ts.*@snowluma\/sdk/);
});

test('只豁免既有 T0 ping spike 的 SDK 导入', (t) => {
  assert.ok(fs.existsSync(checker), '边界检查脚本应存在');
  const fixtureRoot = createFixture(t);
  writeSource(fixtureRoot, 'src/spike/another.ts', "import '@snowluma/sdk';\n");

  const result = runChecker(fixtureRoot);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1, output || result.error?.message);
  assert.match(output, /src\/spike\/another\.ts.*@snowluma\/sdk/);
});

test('store 只允许依赖 core 的 tag-model 模块', (t) => {
  const allowedRoot = createFixture(t);
  writeSource(allowedRoot, 'src/store/tag-repo.ts', "import { isTagCategory } from '../core/impressions/tag-model.ts';\n");
  writeSource(allowedRoot, 'src/core/impressions/tag-model.ts', 'export function isTagCategory(): void {}\n');
  const allowed = runChecker(allowedRoot);
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout || allowed.error?.message);

  const forbiddenRoot = createFixture(t);
  writeSource(forbiddenRoot, 'src/store/tag-repo.ts', "import { tagActivation } from '../core/impressions/tags.ts';\n");
  writeSource(forbiddenRoot, 'src/core/impressions/tags.ts', 'export function tagActivation(): void {}\n');
  const forbidden = runChecker(forbiddenRoot);
  const output = `${forbidden.stdout}\n${forbidden.stderr}`;
  assert.equal(forbidden.status, 1, output || forbidden.error?.message);
  assert.match(output, /store\/tag-repo\.ts.*core\/impressions\/tags\.ts/);
});
