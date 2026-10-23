import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAppraiseMessages, parseAppraiseResponse } from '../src/core/mood/appraise.ts';
import type { AppraisePromptTemplate } from '../src/core/prompt/templates.ts';

const template: AppraisePromptTemplate = {
  source: 'fixture',
  version: 'fixture',
  system: 'valence ±{{MAX_VALENCE_DELTA}}, reserve ±{{MAX_RESERVE_DELTA}}, arousal ±{{MAX_AROUSAL_DELTA}}',
  user: '{{context}}',
};

test('情绪评估解析恰好四字段并使用独立范围', () => {
  assert.deepEqual(parseAppraiseResponse('{"valence":-0.3,"reserve":-0.15,"arousal":0.3,"reason":"有点不安"}'), {
    valence: -0.3,
    reserve: -0.15,
    arousal: 0.3,
    reason: '有点不安',
  });
  assert.equal(parseAppraiseResponse('{"valence":0,"reserve":0,"arousal":0,"reason":"ok","extra":true}'), undefined);
  assert.equal(parseAppraiseResponse('{"valence":0.31,"reserve":0,"arousal":0,"reason":"越界"}'), undefined);
  assert.equal(parseAppraiseResponse('{"valence":0,"reserve":0.16,"arousal":0,"reason":"越界"}'), undefined);
  assert.equal(parseAppraiseResponse('{"valence":0,"reserve":0,"arousal":-0.31,"reason":"越界"}'), undefined);
});

test('评估提示的范围数字与解析常量一致', () => {
  const messages = buildAppraiseMessages([], template);
  const system = String(messages[0]?.content);
  assert.match(system, /valence ±0\.3/u);
  assert.match(system, /reserve ±0\.15/u);
  assert.match(system, /arousal ±0\.3/u);
});
