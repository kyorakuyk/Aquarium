import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPersona, parsePersonaMarkdown } from '../src/persona/load.ts';

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

test('parsePersonaMarkdown 解析结构化字段并将四维档位映射为数值', () => {
  const source = [
    '---',
    'name: 小鲸鱼妈妈精简版',
    'aliases: [小鲸鱼, 鲸鱼妈妈]',
    'identity:',
    '  kind: AI 网络角色',
    '  selfAwareness: 清楚自己是 AI',
    '  nameRule: user-assigned',
    'traits:',
    '  order: m1',
    '  morality: m2',
    '  talk: p1',
    '  mind: p2',
    '  flavor: { warm: 8, dark: 1.5 }',
    'speech:',
    '  firstPerson: 我',
    '  length: { min: 1, max: 150 }',
    '  segmenting: one_message',
    '  catchphrases: [在的呀, 诶?]',
    'audience:',
    '  stranger: 关切收敛',
    '  acquaintance: 会主动投喂',
    '  close: 可以直接管人',
    'modes:',
    '  - name: 闲聊',
    '    trigger: 默认',
    '    behavior: 可以轻松接梗',
    '  - name: 认真',
    '    trigger: [身体不适, 正经求助]',
    '    behavior: 简短真诚',
    'reply:',
    '  mustReply: [被@, 身体不适]',
    'boundaries:',
    '  hard: [不编造查询结果]',
    'examples:',
    '  - scene: 熬夜',
    '    input: 还没睡？',
    '    bad: 注意身体哦',
    '    good: 诶，还醒着呀',
    'background: 熟人群里的妈妈',
    '---',
    '正文背景。',
  ].join('\n');

  const loaded = parsePersonaMarkdown(source);

  assert.deepEqual(loaded.traits, {
    order: -1,
    morality: -2,
    talk: 1,
    mind: 2,
    humor: 0,
    openness: 0,
    imitation: 0,
  });
  assert.equal(loaded.text, '正文背景。');
  assert.equal(loaded.profile?.name, '小鲸鱼妈妈精简版');
  assert.deepEqual(loaded.profile?.aliases, ['小鲸鱼', '鲸鱼妈妈']);
  assert.equal(loaded.profile?.identity.kind, 'AI 网络角色');
  assert.equal(loaded.profile?.speech.segmenting, 'one_message');
  assert.equal(loaded.profile?.audience?.close, '可以直接管人');
  assert.equal(loaded.profile?.modes?.[1]?.name, '认真');
  assert.deepEqual(loaded.profile?.reply.mustReply, ['被@', '身体不适']);
  assert.deepEqual(loaded.profile?.boundaries.hard, ['不编造查询结果']);
  assert.equal(loaded.profile?.background, '熟人群里的妈妈\n\n正文背景。');
});

test('旧角色卡正文中的横线分隔符不会被误当成 YAML 文件头', () => {
  const source = '角色介绍\n---\n- 不是 YAML\n---\n后续正文';
  const loaded = parsePersonaMarkdown(source);

  assert.equal(loaded.text, source);
  assert.deepEqual(loaded.traits, { order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0 });
});
