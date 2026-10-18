import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  baseTime,
  createProactiveHarness,
  makeIncoming,
  withRepository,
} from './pipeline-test-helpers.ts';

test('话量底色和会话偏移共同调整主动阈值与 traits 提示块', async () => {
  await withRepository(async (repository, personaRoot) => {
    fs.writeFileSync(path.join(personaRoot, 'personas', 'default.md'), [
      '---',
      'traits:',
      '  talk: 1',
      '---',
      '临时测试人设。',
    ].join('\n'), 'utf8');
    const harness = createProactiveHarness(repository, personaRoot, { talkOffset: 1 });

    const result = await harness.pipeline(makeIncoming({
      messageId: 'talk-threshold',
      plainText: '今晚吃什么？',
      time: baseTime - 1_000,
    }));

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    const detail = repository.recentDecisions(1)[0]?.detail as {
      threshold?: number;
      promptBlocks?: Array<{ id: string }>;
    };
    assert.equal(detail.threshold, 0.25);
    assert.ok(harness.modelRequests.find(({ slot }) => slot === 'reply')?.messages[0]?.content.includes('你是个话痨'));
    assert.ok(detail.promptBlocks?.some(({ id }) => id === 'traits'));
  });
});

test('极低话量将长回复完整合并成一条', async () => {
  await withRepository(async (repository, personaRoot) => {
    fs.writeFileSync(path.join(personaRoot, 'personas', 'default.md'), [
      '---',
      'traits:',
      '  talk: -2',
      '---',
      '临时测试人设。',
    ].join('\n'), 'utf8');
    const replyText = '甲'.repeat(250);
    const harness = createProactiveHarness(repository, personaRoot, { replyText });

    const result = await harness.pipeline(makeIncoming({
      messageId: 'talk-parts',
      plainText: '今晚吃什么？',
      time: baseTime - 1_000,
    }));

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.equal(harness.adapter.sent.length, 1);
    assert.equal(harness.adapter.sent[0]?.segments.at(-1)?.type, 'text');
    assert.equal(harness.adapter.sent[0]?.segments.at(-1)?.text, replyText);
  });
});
