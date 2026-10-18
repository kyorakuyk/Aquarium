import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveTalkLevel, renderTraitsBlock, replyPartLimitForTalk } from '../src/persona/traits.ts';
import type { PersonaTraits } from '../src/persona/load.ts';
import type { TraitsPromptTemplate } from '../src/core/prompt-templates.ts';

const template: TraitsPromptTemplate = {
  source: '',
  version: '',
  order: { m2: '守规矩。', m1: '较守规矩。', p1: '随性。', p2: '很随性。' },
  morality: { m2: '善良。', m1: '心地好。', p1: '有点坏心眼。', p2: '爱恶作剧。' },
  talk: { m2: '很文静。', m1: '偏安静。', p1: '爱说话。', p2: '话痨。' },
  mind: { m2: '很理性。', m1: '偏理性。', p1: '偏感性。', p2: '很感性。' },
};

test('effectiveTalkLevel 将底色与会话偏移相加并限制在 -2 到 2', () => {
  assert.equal(effectiveTalkLevel(-1, -2), -2);
  assert.equal(effectiveTalkLevel(1, 2), 2);
  assert.equal(effectiveTalkLevel(1, -1), 0);
});

test('replyPartLimitForTalk 按有效话量设置最多拆条数', () => {
  assert.equal(replyPartLimitForTalk(-2), 1);
  assert.equal(replyPartLimitForTalk(-1), 2);
  for (const talk of [0, 1, 2]) assert.equal(replyPartLimitForTalk(talk), 3);
});

test('renderTraitsBlock 按守序、善良、话量、思维顺序渲染且省略 0 档', () => {
  const traits: PersonaTraits = { order: -2, morality: 0, talk: -2, mind: 1 };
  assert.equal(renderTraitsBlock(traits, 2, template), '守规矩。 话痨。 偏感性。');
  assert.equal(renderTraitsBlock({ order: 0, morality: 0, talk: 0, mind: 0 }, 0, template), '');
});
