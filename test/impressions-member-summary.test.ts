import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemberSummaryService } from '../src/core/impressions/member-summary.ts';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import { promptTemplateStore } from '../src/core/prompt-templates.ts';
import { sessionId } from '../src/core/events.ts';
import { createRepository } from '../src/store/repository.ts';
import { openDatabase } from '../src/store/db.ts';
import { createMemberSummaryRepository } from '../src/store/member-summary-repo.ts';
import { baseTime, groupSession, makeConfig } from './pipeline-test-helpers.ts';

test('提取窗口中的群友即使未返回新标签也会触发一句话印象检查', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const summaryRepository = createMemberSummaryRepository(database);
    const key = sessionId(groupSession);
    const insertTag = (
      text: string,
      category: 'personality' | 'schedule' | 'fandom',
      subject: string | null = null,
      polarity: 'like' | null = null,
    ) => repository.insertTag({
      account: groupSession.account,
      sessionId: key,
      userId: 42,
      text,
      norm: text,
      category,
      subject,
      polarity,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 3,
      evidence: [],
      firstSeen: baseTime,
      lastSeen: baseTime,
      supersededBy: null,
      updatedAt: baseTime,
    });
    insertTag('慢热', 'personality');
    insertTag('夜猫子', 'schedule');
    insertTag('CS2', 'fandom', '游戏', 'like');
    const summaryCalls: string[] = [];
    const memberSummaryService = createMemberSummaryService({
      repository,
      summaryRepository,
      getConfig: makeConfig,
      getTemplate: () => promptTemplateStore.get().memberSummary,
      callModel: async (slot) => {
        summaryCalls.push(slot);
        return {
          text: '安静细致，喜欢深入交流。',
          provider: 'fake',
          model: 'fake-summary',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
      now: () => baseTime,
    });
    const service = createImpressionsService({
      repository,
      getConfig: makeConfig,
      callModel: async () => ({
        text: JSON.stringify({
          group: { observe: [], new: [], contradict: [] },
          members: [],
        }),
        provider: 'fake',
        model: 'fake-extract',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
      onMemberSummaryCheck: memberSummaryService.maybeGenerate,
    });
    const release = service.tryAcquireSession(key);
    assert.ok(release);
    try {
      const result = await service.extractWindowUnderSessionLock({
        session: groupSession,
        records: [{
          sessionId: key,
          messageId: 'summary-hook',
          senderId: 42,
          senderName: '小明',
          isSelf: false,
          plainText: '我喜欢慢热的交流',
          segments: [],
          time: baseTime,
        }],
        now: baseTime,
        template: promptTemplateStore.get().extractTags,
      });

      assert.equal(result.status, 'done');
      await memberSummaryService.idle();
      assert.deepEqual(summaryCalls, ['extract']);
      assert.equal(summaryRepository.get(groupSession.account, 42)?.text, '安静细致，喜欢深入交流。');
    } finally {
      release();
    }
  } finally {
    database.close();
  }
});
