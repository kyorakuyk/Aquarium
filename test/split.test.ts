import assert from 'node:assert/strict';
import test from 'node:test';
import { splitReply } from '../src/core/split.ts';

test('splitReply 保留短回复为一条并按中文标点拆分', () => {
  assert.deepEqual(splitReply('  你好呀！  '), ['你好呀！']);
  assert.deepEqual(splitReply('第一句。第二句！第三句？'), ['第一句。', '第二句！', '第三句？']);
});

test('splitReply 对超长无标点文本按 Unicode 字符切分且每条不超过上限', () => {
  const parts = splitReply('🌱'.repeat(81));

  assert.deepEqual(parts.map((part) => Array.from(part).length), [80, 1]);
  assert.equal(parts.join(''), '🌱'.repeat(81));
});

test('splitReply 最多发三条并把多余内容合并到最后一条', () => {
  const parts = splitReply('甲'.repeat(250));

  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((part) => Array.from(part).length), [80, 80, 90]);
  assert.equal(parts.join(''), '甲'.repeat(250));
});
