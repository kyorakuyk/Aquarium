import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { messageRecord } from '../src/core/conversation/steps/types.ts';
import { createPersonaMemoryService } from '../src/core/persona-memory.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { baseTime, FakeAdapter, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

function storeAndObserveMessage(
  repository: Parameters<typeof createPersonaMemoryService>[0]['repository'],
  service: ReturnType<typeof createPersonaMemoryService>,
  message: ReturnType<typeof makeIncoming>,
): boolean {
  if (!repository.saveMessage(messageRecord(message, sessionId(message.session)))) return false;
  return service.observeMessage(message);
}

test('sleep organization preserves same-second arrivals during event extraction', async () => {
  await withRepository(async (repository) => {
    const observed = [
      makeIncoming({ session: groupSession, messageId: 'idle-1', senderId: 82, plainText: '随口一说', time: baseTime }),
      makeIncoming({ session: groupSession, messageId: 'idle-2', senderId: 83, plainText: '哈哈', time: baseTime + 1_000 }),
      makeIncoming({ session: groupSession, messageId: 'event-1', senderId: 82, plainText: '周末一起看展？', time: baseTime + 21 * 60_000 }),
      makeIncoming({ session: groupSession, messageId: 'event-2', senderId: 83, plainText: '好呀，周六下午。', time: baseTime + 21 * 60_000 + 1_000 }),
      makeIncoming({ session: groupSession, messageId: 'event-3', senderId: 82, plainText: '我来订票。', time: baseTime + 21 * 60_000 + 2_000 }),
      makeIncoming({ session: groupSession, messageId: 'event-4', senderId: 83, plainText: '那我负责找餐厅。', time: baseTime + 21 * 60_000 + 3_000 }),
    ];
    let observeDuringExtraction: (message: ReturnType<typeof makeIncoming>) => boolean = () => false;
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      isSignificantSegment: (_session, records) => records.length >= 4,
      processSession: async (session, records, now) => {
        assert.equal(session.kind, 'group');
        assert.equal(records.length, 4);
        const first = records[0]!;
        const last = records.at(-1)!;
        const arrivingDuringExtraction = makeIncoming({
          session: groupSession,
          messageId: 'same-second-during-extract',
          senderId: 82,
          plainText: '同一秒内到达的后续消息。',
          time: last.time,
        });
        assert.equal(repository.saveMessage(messageRecord(
          arrivingDuringExtraction,
          sessionId(arrivingDuringExtraction.session),
        )), true);
        assert.equal(observeDuringExtraction(arrivingDuringExtraction), true);
        const eventId = repository.upsertGroupEvent({
          account: session.account,
          sourceGroupId: session.peer,
          anchorMessageId: first.messageId,
          title: '周末看展',
          summary: '群友约好周六看展并安排餐厅。',
          participantIds: [82, 83],
          evidenceMessageIds: records.map(({ messageId }) => messageId),
          occurredAt: first.time,
          createdAt: now,
          updatedAt: now,
        });
        return {
          status: 'done',
          memos: [{
            account: session.account,
            sessionId: sessionId(session),
            eventId,
            title: '周末看展',
            summary: '群友约好周六看展并安排餐厅。',
            participantIds: [82, 83],
            startMessageId: first.messageId,
            endMessageId: last.messageId,
            level: 'L0',
            createdAt: now,
          }],
        };
      },
    });
    observeDuringExtraction = (message) => service.observeMessage(message);
    for (const message of observed) {
      assert.equal(storeAndObserveMessage(repository, service, message), true);
    }

    const result = await service.organizeAtSleep({
      account: groupSession.account,
      cycleKey: '2026-10-23',
      now: baseTime + 30 * 60_000,
    });
    assert.equal(result.status, 'partial', JSON.stringify({ result, run: repository.personaMemoryRun(groupSession.account, '2026-10-23') }));
    assert.equal(result.processedCount, 6);
    assert.deepEqual(repository.listPersonaMemoryPendingMessages(groupSession.account, sessionId(groupSession))
      .map(({ messageId }) => messageId), ['same-second-during-extract']);
    assert.deepEqual(repository.listPersonaEventMemos(groupSession.account, 10).map(({ title, eventId }) => ({ title, eventId })), [
      { title: '周末看展', eventId: 1 },
    ]);
    assert.deepEqual(repository.listPersonaMemoryTailMessages(groupSession.account, 10).map(({ messageId }) => messageId), [
      'idle-1', 'idle-2',
    ]);
    assert.equal(repository.listPersonaMemos(groupSession.account, 10).length, 0);
    assert.equal(repository.personaMemoryCursor(groupSession.account, sessionId(groupSession))?.organizedUntilMessageTime,
      baseTime + 21 * 60_000 + 3_000);
  });
});

test('disabled sessions keep their source messages pending while other sessions continue', async () => {
  await withRepository(async (repository) => {
    const disabledSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 81 };
    const enabledSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 82 };
    const processedSessions: string[] = [];
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      canProcessSession: (session) => sessionId(session) !== sessionId(disabledSession),
      processSession: async (session) => {
        processedSessions.push(sessionId(session));
        return 'done';
      },
    });
    for (const [session, messageId, time] of [
      [disabledSession, 'disabled-oldest', baseTime],
      [enabledSession, 'enabled-later', baseTime + 1],
    ] as const) {
      assert.equal(storeAndObserveMessage(repository, service, makeIncoming({
        session,
        messageId,
        senderId: session.peer,
        plainText: messageId,
        time,
      })), true);
    }

    const result = await service.organizeAtSleep({
      account: groupSession.account,
      cycleKey: '2026-10-23',
      now: baseTime + 2_000,
    });
    assert.equal(result.status, 'partial');
    assert.deepEqual(processedSessions, [sessionId(enabledSession)]);
    assert.deepEqual(repository.listPersonaMemoryCursorSummaries(groupSession.account)
      .filter(({ pendingMessageCount }) => pendingMessageCount > 0)
      .map(({ sessionId: pendingSession }) => pendingSession), [sessionId(disabledSession)]);
  });
});

test('duplicate delivery retries a cursor write that failed after the message was saved', async () => {
  await withRepository(async (repository, personaRoot) => {
    const saveCursor = repository.savePersonaMemoryCursor.bind(repository);
    let failNextCursorWrite = true;
    repository.savePersonaMemoryCursor = (cursor) => {
      if (failNextCursorWrite) {
        failNextCursorWrite = false;
        throw new Error('temporary cursor write failure');
      }
      saveCursor(cursor);
    };
    const memory = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig({ nicknames: [] }),
      processSession: async () => 'done',
    });
    const adapter = new FakeAdapter();
    const pipeline = createMessagePipeline({
      getConfig: () => makeConfig({ nicknames: [] }),
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      personaMemoryService: memory,
    });
    const message = makeIncoming({
      session: groupSession,
      messageId: 'memo-write-retry',
      senderId: 82,
      plainText: '这条消息的 memo 首次写入会失败。',
      time: baseTime,
    });

    await pipeline(message);
    assert.equal(repository.messageBySessionAndId(sessionId(groupSession), message.messageId)?.messageId, message.messageId);
    assert.equal(repository.listPersonaMemoryCursorSummaries(groupSession.account).length, 0);
    await pipeline(message);

    assert.equal(repository.listPersonaMemoryCursorSummaries(groupSession.account)[0]?.pendingMessageCount, 1);
    assert.equal(repository.listPersonaMemos(groupSession.account, 10).length, 0);
  });
});

test('running-cycle recovery resumes after segment cursor and diary commits', async () => {
  await withRepository(async (repository) => {
    const firstSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 82 };
    const secondSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 83 };
    let newlyProcessed = 0;
    const interruptedService = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async (_session, records) => { newlyProcessed += records.length; return 'done'; },
    });
    for (const [session, messageId, text, createdAt] of [
      [firstSession, 'recover-first', '第一个来源已经处理。', baseTime],
      [secondSession, 'recover-second', '第二个来源恢复后处理。', baseTime + 1],
    ] as const) {
      assert.equal(storeAndObserveMessage(repository, interruptedService, makeIncoming({
        session, messageId, senderId: session.peer, plainText: text, time: createdAt,
      })), true);
    }

    const finishRun = repository.finishPersonaMemoryRun.bind(repository);
    let interruptFinish = true;
    repository.finishPersonaMemoryRun = (input) => {
      if (interruptFinish) {
        interruptFinish = false;
        throw new Error('simulated interruption before run finalization');
      }
      finishRun(input);
    };
    await assert.rejects(interruptedService.organizeAtSleep({
      account: groupSession.account,
      cycleKey: '2026-10-23',
      now: baseTime + 60 * 60_000,
    }), /simulated interruption before run finalization/u);
    assert.equal(repository.personaMemoryRun(groupSession.account, '2026-10-23')?.status, 'running');
    assert.equal(repository.personaMemoryRun(groupSession.account, '2026-10-23')?.processedCount, 2);

    repository.finishPersonaMemoryRun = finishRun;
    let resumedProcessing = 0;
    const resumedService = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async () => { resumedProcessing += 1; return 'done'; },
    });
    const resumed = await resumedService.organizeAtSleep({
      account: groupSession.account,
      cycleKey: '2026-10-23',
      now: baseTime + 61 * 60_000,
    });

    assert.equal(resumed.status, 'done');
    assert.equal(newlyProcessed, 2);
    assert.equal(resumedProcessing, 0);
    assert.equal(repository.personaMemoryRun(groupSession.account, '2026-10-23')?.processedCount, 2);
    assert.equal(repository.listPersonaMemoryCursorSummaries(groupSession.account)
      .reduce((total, cursor) => total + cursor.pendingMessageCount, 0), 0);
    const diary = repository.listPersonaDiaries(groupSession.account, 10)[0];
    assert.equal(diary?.sourceCount, 2);
    assert.match(diary?.text ?? '', /第二个来源恢复后处理/u);
  });
});

test('message staging preserves full unicode source without creating a duplicate raw memo', async () => {
  await withRepository(async (repository) => {
    const memory = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async () => 'done',
    });
    const message = makeIncoming({
      session: groupSession,
      messageId: 'emoji-length-limit',
      senderId: 82,
      plainText: '😀'.repeat(1_001),
      time: baseTime,
    });

    assert.equal(storeAndObserveMessage(repository, memory, message), true);
    const pending = repository.listPersonaMemoryPendingMessages(groupSession.account, sessionId(groupSession));
    assert.equal(pending[0]?.plainText.length, 2_002);
    assert.equal(pending[0]?.plainText, '😀'.repeat(1_001));
    assert.equal(repository.listPersonaMemos(groupSession.account, 10).length, 0);
  });
});

test('running-cycle recovery does not grant a fresh message limit after one thousand were processed', async () => {
  await withRepository(async (repository) => {
    const cycleKey = '2026-10-23';
    const message = makeIncoming({
      session: groupSession,
      messageId: 'after-cycle-limit',
      senderId: 82,
      plainText: '超出本周期预算的消息。',
      time: baseTime + 1,
    });
    let processCalls = 0;
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async () => { processCalls += 1; return 'done'; },
    });
    assert.equal(storeAndObserveMessage(repository, service, message), true);
    assert.equal(repository.startPersonaMemoryRun({
      account: groupSession.account,
      cycleKey,
      memoCount: 1_001,
      startedAt: baseTime,
    }), true);
    assert.equal(repository.resumePersonaMemoryRun({
      account: groupSession.account,
      cycleKey,
      memoCount: 1_001,
      processedCount: 1_000,
    }), true);
    repository.insertPersonaDiary({
      account: groupSession.account,
      cycleKey,
      text: 'first batch diary',
      sourceCount: 1_000,
      createdAt: baseTime,
    });

    const result = await service.organizeAtSleep({
      account: groupSession.account,
      cycleKey,
      now: baseTime + 2_000,
    });

    assert.equal(result.status, 'partial');
    assert.equal(processCalls, 0);
    assert.equal(repository.listPersonaMemoryCursorSummaries(groupSession.account)[0]?.pendingMessageCount, 1);
    assert.equal(repository.personaMemoryRun(groupSession.account, cycleKey)?.status, 'partial');
    assert.equal(repository.personaDiary(groupSession.account, cycleKey)?.sourceCount, 1_000);
  });
});

test('recent diary prompt keeps JSON valid while enforcing its character limit', async () => {
  await withRepository(async (repository) => {
    const fakeToken = ['FAKE', '_TOKEN', '_VALUE', '_123456'].join('');
    const sourceEntries = Array.from({ length: 8 }, (_, index) => ({
      sessionId: sessionId(groupSession),
      messageId: `large-diary-${index}`,
      senderName: `token=${fakeToken}`,
      text: '日'.repeat(1_200),
      createdAt: baseTime + index,
    }));
    repository.insertPersonaDiary({
      account: groupSession.account,
      cycleKey: '2026-10-22',
      text: '大日记',
      sourceEntries,
      sourceCount: sourceEntries.length,
      createdAt: baseTime,
    });
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async () => 'done',
    });

    const block = service.recentDiaryBlock(groupSession.account, groupSession, baseTime + 100) ?? '';
    const payload = block.slice(block.indexOf('\n') + 1);
    const parsed = JSON.parse(payload) as Array<{ senderName: string; text: string }>;
    assert.ok(block.length <= 3_000);
    assert.ok(parsed.length > 0);
    assert.equal(parsed.at(-1)?.senderName, '[敏感内容已隐藏]');
    assert.equal(parsed.at(-1)?.text, '日'.repeat(1_200));
  });
});

test('running-cycle recovery defers a segment larger than the remaining cycle capacity', async () => {
  await withRepository(async (repository) => {
    const cycleKey = '2026-10-23';
    let processCalls = 0;
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async () => { processCalls += 1; return 'done'; },
    });
    for (let index = 0; index < 6; index += 1) {
      assert.equal(storeAndObserveMessage(repository, service, makeIncoming({
        session: groupSession,
        messageId: `over-capacity-${index}`,
        senderId: 82,
        plainText: `消息 ${index}`,
        time: baseTime + index,
      })), true);
    }
    assert.equal(repository.startPersonaMemoryRun({
      account: groupSession.account,
      cycleKey,
      memoCount: 1_001,
      startedAt: baseTime,
    }), true);
    assert.equal(repository.resumePersonaMemoryRun({
      account: groupSession.account,
      cycleKey,
      memoCount: 1_001,
      processedCount: 995,
    }), true);
    repository.insertPersonaDiary({
      account: groupSession.account,
      cycleKey,
      text: '已有日记',
      sourceCount: 995,
      createdAt: baseTime,
    });

    const result = await service.organizeAtSleep({ account: groupSession.account, cycleKey, now: baseTime + 2_000 });
    assert.equal(result.status, 'partial');
    assert.equal(result.processedCount, 995);
    assert.equal(processCalls, 0);
    assert.equal(repository.listPersonaMemoryCursorSummaries(groupSession.account)[0]?.pendingMessageCount, 6);
    assert.equal(repository.personaMemoryRun(groupSession.account, cycleKey)?.status, 'partial');
  });
});
