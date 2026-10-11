import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadPersona } from '../src/persona/load.ts';

function createRoot(): string {
  return fs.mkdtempSync(path.join(process.cwd(), '.tmp-persona-'));
}

test('loadPersona 优先读取 data/personas 并替换 {{name}}', () => {
  const root = createRoot();
  try {
    fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data', 'personas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'personas', 'default.md'), '仓库人设：{{name}}', 'utf8');
    fs.writeFileSync(path.join(root, 'data', 'personas', 'default.md'), '用户人设：{{name}}', 'utf8');

    assert.equal(loadPersona('default', '小鱼', { root }), '用户人设：小鱼');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPersona 回退到仓库人设并拒绝路径穿越', () => {
  const root = createRoot();
  try {
    fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'personas', 'default.md'), '你好，{{name}}。', 'utf8');

    assert.equal(loadPersona('default', '水族箱', { root }), '你好，水族箱。');
    assert.equal(loadPersona('default', '$&', { root }), '你好，$&。');
    assert.throws(() => loadPersona('../outside', '水族箱', { root }), /无效的人设 ID/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
