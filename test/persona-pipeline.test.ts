import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { getPersonaForMessage } from '../src/core/conversation/steps/persona.ts';
import { sessionId } from '../src/core/shared/events.ts';
import {
  createHarness,
  groupSession,
  makeConfig,
  makeIncoming,
  withRepository,
} from './pipeline-test-helpers.ts';

test('pipeline 人设缓存保留 frontmatter 中的好感模式', async () => {
  await withRepository(async (_repository, personaRoot) => {
    fs.writeFileSync(path.join(personaRoot, 'personas', 'default.md'), [
      '---',
      'affinity: { mode: independent }',
      '---',
      '人设正文',
    ].join('\n'), 'utf8');
    const config = makeConfig();
    const context = {
      message: { session: groupSession },
      options: { getConfig: () => config, getNickname: () => '', personaRoot },
      state: { config },
    } as unknown as Parameters<typeof getPersonaForMessage>[0];

    const loaded = getPersonaForMessage(context);
    const cached = getPersonaForMessage(context);

    assert.deepEqual(loaded.affinity, { mode: 'independent' });
    assert.deepEqual(cached.affinity, loaded.affinity);
  });
});

test('人设 mustReply 短语可在 mention_only 模式触发回复', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const baseConfig = makeConfig({
      nicknames: [],
      sessions: { [key]: { mode: 'mention_only' } },
    });
    const config = AquariumConfigSchema.parse({
      ...baseConfig,
      accounts: baseConfig.accounts.map((account) => ({ ...account, persona: 'must-reply' })),
    });
    fs.writeFileSync(path.join(personaRoot, 'personas', 'must-reply.md'), [
      '---',
      'name: 必回测试',
      'aliases: []',
      'identity: { kind: 测试角色, selfAwareness: 知道身份, nameRule: fixed }',
      'traits: { order: 0, morality: 0, talk: 0, mind: 0 }',
      'speech:',
      '  firstPerson: 我',
      '  length: { min: 1, max: 100 }',
      '  segmenting: multi',
      '  catchphrases: []',
      'reply:',
      '  mustReply: [身体不适]',
      'boundaries: { hard: [不编造] }',
      '---',
      '背景',
    ].join('\n'), 'utf8');
    const harness = createHarness(repository, config, personaRoot);

    const result = await harness.pipeline(makeIncoming({
      messageId: 'persona-must-reply',
      plainText: '身体不适',
    }));

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.equal(harness.modelRequests[0]?.slot, 'reply');
    assert.equal(harness.adapter.sent.length, 1);
  });
});

test('结构化人设的 segmenting 与 length 控制实际分条发送', async () => {
  await withRepository(async (repository, personaRoot) => {
    const baseConfig = makeConfig();
    const config = AquariumConfigSchema.parse({
      ...baseConfig,
      accounts: baseConfig.accounts.map((account) => ({ ...account, persona: 'multi' })),
    });
    fs.writeFileSync(path.join(personaRoot, 'personas', 'multi.md'), [
      '---',
      'name: 分条测试',
      'aliases: []',
      'identity: { kind: 测试角色, selfAwareness: 知道身份, nameRule: fixed }',
      'traits: { order: 0, morality: 0, talk: 0, mind: 0 }',
      'speech:',
      '  firstPerson: 我',
      '  length: { min: 1, max: 40 }',
      '  segmenting: multi',
      '  catchphrases: []',
      'boundaries: { hard: [不编造] }',
      '---',
      '背景',
    ].join('\n'), 'utf8');
    const harness = createHarness(repository, config, personaRoot, { replyText: '甲'.repeat(100) });

    const result = await harness.pipeline(makeIncoming({ messageId: 'structured-split' }));

    assert.equal(result.reason, 'replied');
    assert.deepEqual(harness.adapter.sent.map(({ segments }) => {
      const text = segments.find((segment) => segment.type === 'text');
      return text?.type === 'text' ? Array.from(text.text).length : 0;
    }), [40, 40, 20]);
  });
});
