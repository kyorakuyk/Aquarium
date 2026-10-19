import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPersona } from '../src/persona/load.ts';

function createRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-persona-'));
}

test('loadPersona 优先读取 data/personas 并替换 {{name}}', () => {
  const root = createRoot();
  try {
    fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data', 'personas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'personas', 'default.md'), '仓库人设：{{name}}', 'utf8');
    fs.writeFileSync(path.join(root, 'data', 'personas', 'default.md'), '用户人设：{{name}}', 'utf8');

    assert.deepEqual(loadPersona('default', '小鱼', { root }), {
      text: '用户人设：小鱼',
      traits: { order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0 },
    });
    const exactSource = '\r\n  原样保留  \r\n';
    fs.writeFileSync(path.join(root, 'data', 'personas', 'plain.md'), exactSource, 'utf8');
    const plain = loadPersona('plain', '小鱼', { root });
    assert.deepEqual(Buffer.from(plain.text), Buffer.from(exactSource));
    assert.deepEqual(plain.traits, { order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPersona 回退到仓库人设并拒绝路径穿越', () => {
  const root = createRoot();
  try {
    fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'personas', 'default.md'), '你好，{{name}}。', 'utf8');

    assert.equal(loadPersona('default', '水族箱', { root }).text, '你好，水族箱。');
    assert.equal(loadPersona('default', '$&', { root }).text, '你好，$&。');
    assert.throws(() => loadPersona('../outside', '水族箱', { root }), /无效的人设 ID/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPersona 解析并剥离性格文件头，缺省维度为零且保留正文', () => {
  const root = createRoot();
  try {
    fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'personas', 'default.md'), [
      '---',
      'traits:',
      '  order: -2',
      '  morality: 1',
      '  talk: 2',
      '---',
      '',
      '第一行  {{name}}  ',
      '',
    ].join('\n'), 'utf8');

    const loaded = loadPersona('default', '小鱼', { root });
    assert.deepEqual(loaded.traits, { order: -2, morality: 1, talk: 2, mind: 0, humor: 0, openness: 0, imitation: 0 });
    assert.equal(loaded.text, '\n第一行  小鱼  \n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPersona 非法性格值报出具体字段', () => {
  const root = createRoot();
  try {
    fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
    fs.writeFileSync(path.join(root, 'personas', 'default.md'), '---\ntraits:\n  morality: 3\n---\n正文', 'utf8');

    assert.throws(() => loadPersona('default', '小鱼', { root }), /morality/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
