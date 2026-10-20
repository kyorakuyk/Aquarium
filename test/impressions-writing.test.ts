import assert from 'node:assert/strict';
import test from 'node:test';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

test('提取去掉标签前缀，并记录 schedule_by_stats 丢弃原因', async () => {
  await withRepository(async (repository) => {
    const key = sessionId(groupSession);
    const now = new Date(2026, 9, 12, 9, 0).getTime();
    const summaryRows = [
      {
        sessionId: key,
        messageId: 'topic-message',
        senderId: 42,
        senderName: '群友',
        isSelf: false,
        plainText: '群里常聊游戏',
        segments: [],
        time: now - 1_000,
      },
      {
        sessionId: key,
        messageId: 'schedule-message',
        senderId: 43,
        senderName: '另一位群友',
        isSelf: false,
        plainText: '最近熬夜很多',
        segments: [],
        time: now,
      },
    ];
    const service = createImpressionsService({
      repository,
      getConfig: () => makeConfig({ nicknames: [] }),
      now: () => now,
      callModel: async () => ({
        text: JSON.stringify({
          group: {
            observe: [],
            new: [
              {
                text: '爱游戏', messageId: 'topic-message', category: 'topic', subject: null,
                polarity: null, origin: 'inferred', sensitive: false,
              },
              {
                text: '熬夜玩家', messageId: 'schedule-message', category: 'personality', subject: null,
                polarity: null, origin: 'inferred', sensitive: false,
              },
            ],
            contradict: [],
          },
          members: [],
        }),
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
    });
    const release = service.tryAcquireSession(key);
    assert.ok(release);
    try {
      const summary = await service.extractWindowUnderSessionLock({
        session: groupSession,
        records: summaryRows,
        now,
        template: promptTemplateStore.get().extractTags,
      });
      const tags = repository.listTagsForSubject(groupSession.account, key, null);
      assert.equal(summary.inserted, 1);
      assert.equal(summary.dropped, 1);
      assert.deepEqual(summary.droppedTagReasons, { schedule_by_stats: 1 });
      assert.deepEqual(tags.map(({ text, category }) => ({ text, category })), [{ text: '游戏', category: 'topic' }]);
    } finally {
      release();
    }
  });
});

test('群梗注入提示块时用中文引号标示原话', async () => {
  await withRepository(async (repository) => {
    const key = sessionId(groupSession);
    const now = new Date(2026, 9, 12, 9, 0).getTime();
    repository.insertTag({
      account: groupSession.account,
      sessionId: key,
      userId: null,
      text: '今晚不聊政治',
      norm: '今晚不聊政治',
      category: 'meme',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 2,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    const service = createImpressionsService({
      repository,
      getConfig: () => makeConfig(),
      now: () => now,
    });

    const blocks = service.promptBlocks({
      session: groupSession,
      sessionId: key,
      senderId: 42,
      senderName: '群友',
      now,
      template: promptTemplateStore.get().replySystem,
    });

    assert.ok(blocks.groupTags?.includes('「今晚不聊政治」'));
  });
});
