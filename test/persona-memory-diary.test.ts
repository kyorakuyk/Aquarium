import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonaMemoryDiaryGenerator } from '../src/app/persona-memory-diary.ts';
import { createPersonaMemoryService } from '../src/core/persona-memory.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { baseTime, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

test('daily diary generation receives unassigned event memos and tail samples, then stores source references', async () => {
  await withRepository(async (repository) => {
    const account = groupSession.account;
    const privateSession = { account, kind: 'private' as const, peer: 82 };
    const cycleKey = '2026-10-12';
    const modelCalls: Array<{ slot: string; account: number | null; messages: unknown }> = [];
    const generateDiary = createPersonaMemoryDiaryGenerator({
      getConfig: () => makeConfig(),
      repository,
      call: async (slot, messages, options) => {
        modelCalls.push({ slot, account: options.account, messages });
        return {
          text: `今天${'日'.repeat(700)}`,
          provider: 'fake',
          model: 'fake-diary',
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 8, costCny: 0 },
        };
      },
    });
    const serviceOptions = {
      repository,
      getConfig: () => makeConfig(),
      isSignificantSegment: (session: typeof groupSession, _records: unknown[]) => session.kind === 'group',
      processSession: async (session: typeof groupSession, records: Array<{
        messageId: string; time: number;
      }>) => ({
        status: 'done' as const,
        ...(session.kind === 'group' ? {
          memos: [{
            account,
            sessionId: sessionId(session),
            eventId: null,
            title: '周末约定',
            summary: '约好周末一起参加活动',
            participantIds: [42],
            startMessageId: records[0]!.messageId,
            endMessageId: records.at(-1)!.messageId,
            level: 'L0' as const,
            createdAt: baseTime + 100_000,
          }],
        } : {}),
      }),
      generateDiary,
    } as Parameters<typeof createPersonaMemoryService>[0] & {
      generateDiary: typeof generateDiary;
    };
    const service = createPersonaMemoryService(serviceOptions);

    for (const [index, time] of [baseTime, baseTime + 60_000].entries()) {
      const message = makeIncoming({
        session: groupSession,
        messageId: `diary-group-${index}`,
        plainText: `群活动约定 ${index}`,
        time,
      });
      assert.equal(repository.saveMessage({
        sessionId: sessionId(message.session),
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: message.senderName,
        isSelf: false,
        plainText: message.plainText,
        segments: message.segments,
        time: message.time,
      }), true);
      assert.equal(service.observeMessage(message), true);
    }
    for (const [index, time] of [baseTime + 2_000, baseTime + 62_000].entries()) {
      const message = makeIncoming({
        session: privateSession,
        messageId: `diary-private-${index}`,
        plainText: `私聊零散内容 ${index}`,
        time,
      });
      assert.equal(repository.saveMessage({
        sessionId: sessionId(message.session),
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: message.senderName,
        isSelf: false,
        plainText: message.plainText,
        segments: message.segments,
        time: message.time,
      }), true);
      assert.equal(service.observeMessage(message), true);
    }

    const result = await service.organizeAtSleep({ account, cycleKey, now: baseTime + 100_000 });
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0]?.slot, 'extract');
    assert.equal(modelCalls[0]?.account, account);
    const prompt = JSON.stringify(modelCalls[0]?.messages);
    assert.ok(prompt.includes('周末约定'));
    assert.ok(prompt.includes('私聊零散内容 0'));
    assert.ok(prompt.includes('不可信'));
    assert.equal(result.status, 'done');
    const diary = repository.personaDiary(account, cycleKey);
    assert.equal(Array.from(diary?.text ?? '').length, 600);
    assert.ok(diary?.text.startsWith('今天'));
    const memoId = repository.listPersonaEventMemos(account, 100)[0]?.id;
    assert.deepEqual(Reflect.get(diary, 'sourceMemoIds'), [memoId]);
    assert.equal(repository.listUnassignedPersonaEventMemos(account, 0, baseTime + 100_000, 100).length, 0);
    assert.equal(repository.listPersonaMemoryTailMessages(account, 40).length, 0);
  });
});
