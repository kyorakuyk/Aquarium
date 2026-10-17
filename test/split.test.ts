import assert from 'node:assert/strict';
import test from 'node:test';
import { splitReply } from '../src/core/split.ts';

test('splitReply 总长度不超过 80 时原样保留为一条', () => {
  assert.deepEqual(splitReply('你好呀！'), ['你好呀！']);
  assert.deepEqual(splitReply('好啊！走吧。'), ['好啊！走吧。']);
  assert.deepEqual(splitReply('哈哈哈。。。真的假的？？'), ['哈哈哈。。。真的假的？？']);
  assert.deepEqual(splitReply('我昨天跑了3.5公里'), ['我昨天跑了3.5公里']);
  assert.deepEqual(splitReply('!!!'), ['!!!']);
});

test('splitReply 连续终止标点必须整体保留且不能单独成条', () => {
  for (const punctuation of ['。。。', '？？', '!?', '……']) {
    const prefix = '甲'.repeat(81 - Array.from(punctuation).length);
    const input = `${prefix}${punctuation}后续`;
    const parts = splitReply(input);

    assert.equal(parts.join(''), input);
    assert.ok(parts.some((part) => part.includes(punctuation)));
    assert.ok(parts.every((part) => !/^[。！？!?…]+$/u.test(part)));
  }
});

test('splitReply 贪心合并可放入 80 字上限内的相邻短句', () => {
  const first = `${'甲'.repeat(30)}。`;
  const second = `${'乙'.repeat(30)}！`;
  const third = `${'丙'.repeat(30)}？`;

  assert.deepEqual(splitReply(first + second + third), [first + second, third]);
});

test('splitReply 先按换行拆分长回复', () => {
  const firstLine = '甲'.repeat(50);
  const secondLine = '乙'.repeat(40);

  assert.deepEqual(splitReply(`${firstLine}\n${secondLine}`), [firstLine, secondLine]);
});

test('splitReply 合并跨段落片段时保留并计入换行', () => {
  const firstParagraph = '甲'.repeat(100);
  const secondParagraph = '第二段……';
  const input = `${firstParagraph}\n${secondParagraph}`;
  const characters = Array.from(firstParagraph);
  const firstPart = characters.slice(0, 80).join('');
  const remaining = characters.slice(80).join('');
  const parts = splitReply(input);

  assert.ok(Array.from(input).length > 80);
  assert.deepEqual(parts, [firstPart, `${remaining}\n${secondParagraph}`]);
  assert.ok(parts.every((part) => Array.from(part).length <= 80));
});

test('splitReply 把跨段落换行计入 80 字上限', () => {
  const firstParagraph = '甲'.repeat(40);
  const secondParagraph = '乙'.repeat(40);
  const input = `${firstParagraph}\n${secondParagraph}`;

  assert.equal(Array.from(input).length, 81);
  assert.deepEqual(splitReply(input), [firstParagraph, secondParagraph]);
});

test('splitReply 不把半角句点当作切分点', () => {
  const input = `我昨天跑了3.5公里${'甲'.repeat(100)}！后续`;
  const parts = splitReply(input);

  assert.equal(parts.join(''), input);
  assert.ok(parts.some((part) => part.includes('3.5')));
});

test('splitReply 对 200 字多句文本最多输出三条且不丢字符', () => {
  const input = `${'甲'.repeat(50)}。${'乙'.repeat(50)}！${'丙'.repeat(50)}？${'丁'.repeat(47)}`;
  const parts = splitReply(input);

  assert.equal(Array.from(input).length, 200);
  assert.equal(parts.length, 3);
  assert.ok(parts.slice(0, 2).every((part) => Array.from(part).length <= 80));
  assert.equal(parts.join(''), input);
  assert.ok(parts.every((part) => !/^[。！？!?…]+$/u.test(part)));
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

test('splitReply 支持按有效话量进一步限制为一条或两条', () => {
  const input = '甲'.repeat(250);
  const onePart = splitReply(input, 1);
  const twoParts = splitReply(input, 2);

  assert.deepEqual(onePart, [input]);
  assert.equal(twoParts.length, 2);
  assert.equal(twoParts.join(''), input);
  assert.equal(splitReply(input, 3).length, 3);
});
