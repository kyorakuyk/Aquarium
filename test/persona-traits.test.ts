import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveTalkLevel, renderTraitsBlock, replyPartLimitForTalk } from '../src/persona/traits.ts';
import type { PersonaTraits } from '../src/persona/load.ts';
import type { TraitsPromptTemplate } from '../src/core/prompt/templates.ts';

const template: TraitsPromptTemplate = {
  source: '',
  version: '',
  order: { m2: '守规矩。', m1: '较守规矩。', p1: '随性。', p2: '很随性。' },
  morality: { m2: '善良。', m1: '心地好。', p1: '有点坏心眼。', p2: '爱恶作剧。' },
  talk: { m2: '很文静。', m1: '偏安静。', p1: '爱说话。', p2: '话痨。' },
  mind: { m2: '很理性。', m1: '偏理性。', p1: '偏感性。', p2: '很感性。' },
  humor: { m2: '很正经。', m1: '偏正经。', p1: '有点脱线。', p2: '很脱线。' },
  openness: { m2: '很保守。', m1: '偏保守。', p1: '挺好奇。', p2: '非常好奇。' },
  imitation: { m2: '有自己一套。', m1: '偏向保持自己。', p1: '会跟着用梗。', p2: '爱学群里说法。' },
};

test('effectiveTalkLevel 将底色与会话偏移相加并限制在 -2 到 2', () => {
  assert.equal(effectiveTalkLevel(-1, -2), -2);
  assert.equal(effectiveTalkLevel(1, 2), 2);
  assert.equal(effectiveTalkLevel(1, -1), 0);
});

test('replyPartLimitForTalk 按有效话量设置最多拆条数', () => {
  assert.equal(replyPartLimitForTalk(-2), 1);
  assert.equal(replyPartLimitForTalk(-1), 2);
  assert.equal(replyPartLimitForTalk(-1.3), 2);
  assert.equal(replyPartLimitForTalk(-1.7), 1);
  assert.equal(replyPartLimitForTalk(-0.24), 3);
  assert.equal(replyPartLimitForTalk(-0.25), 2);
  for (const talk of [0, 1, 2]) assert.equal(replyPartLimitForTalk(talk), 3);
});

test('renderTraitsBlock 按七维固定顺序渲染且省略 0 档', () => {
  const traits: PersonaTraits = { order: -2, morality: 0, talk: -2, mind: 1, humor: 1, openness: -2, imitation: 2 };
  assert.equal(renderTraitsBlock(traits, 2, template), '守规矩。 话痨。 偏感性。 有点脱线。 很保守。 爱学群里说法。');
  assert.equal(renderTraitsBlock({ order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0 }, 0, template), '');
});

test('renderTraitsBlock 将小数映射到最近档位并按边界添加程度词', () => {
  const simpleTemplate: TraitsPromptTemplate = {
    ...template,
    order: { m2: 'm2', m1: 'm1', p1: 'p1', p2: 'p2' },
    talk: { m2: 'm2', m1: 'm1', p1: 'p1', p2: 'p2' },
  };
  const renderOrder = (order: number) => renderTraitsBlock({
    order, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0,
  }, 0, simpleTemplate);

  assert.equal(renderOrder(0.24), '');
  assert.equal(renderOrder(0.25), 'p1');
  assert.equal(renderOrder(1.25), 'p1');
  assert.equal(renderOrder(1.3), '略p1');
  assert.equal(renderOrder(1.7), '很p2');
  assert.equal(renderOrder(1.75), 'p2');
  assert.equal(renderOrder(-1.3), '略m1');
  assert.equal(renderOrder(-1.7), '很m2');

  const talkTraits: PersonaTraits = {
    order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0,
  };
  assert.equal(renderTraitsBlock(talkTraits, 1.7, simpleTemplate), '很p2');
  const imitationTraits: PersonaTraits = {
    order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: -1.3,
  };
  assert.equal(renderTraitsBlock(imitationTraits, 0, template), '略微倾向于保持自己。');
});
