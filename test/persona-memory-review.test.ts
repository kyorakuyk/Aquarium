import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { createPersonaMemoryService } from '../src/core/persona-memory.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { baseTime, FakeAdapter, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

test('sleep extraction windows every memo within downstream context limits', async () => {
  await withRepository(async (repository) => {
    const privateSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 82 };
    for (let index = 0; index < 61; index += 1) {
      repository.insertPersonaMemo({
        account: groupSession.account,
        sessionId: sessionId(privateSession),
        messageId: `private-window-${index}`,
        senderId: 82,
        senderName: '朋友',
        isSelf: false,
        text: `私聊 memo ${index}`,
        createdAt: baseTime + index,
      });
    }
    for (let index = 0; index < 81; index += 1) {
      repository.insertPersonaMemo({
        account: groupSession.account,
        sessionId: sessionId(groupSession),
        messageId: `group-window-${index}`,
        senderId: 82,
        senderName: '群友',
        isSelf: false,
        text: `群聊 memo ${index}`,
        createdAt: baseTime + 1_000 + index,
      });
    }
    const windowSizes = new Map<string, number[]>();
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async (session, records) => {
        const key = sessionId(session);
        windowSizes.set(key, [...(windowSizes.get(key) ?? []), records.length]);
        return 'done';
      },
    });

    const result = await service.organizeAtSleep({
      account: groupSession.account,
      cycleKey: '2026-10-23',
      now: baseTime + 2_000,
    });
    assert.equal(result.status, 'done');
    assert.deepEqual(windowSizes.get(sessionId(privateSession)), [60, 1]);
    assert.deepEqual(windowSizes.get(sessionId(groupSession)), [80, 1]);
    assert.equal(result.processedCount, 142);
    assert.equal(repository.listPendingPersonaMemos(groupSession.account, 10).length, 0);
  });
});

test('disabled oldest session does not block enabled sessions in later batches', async () => {
  await withRepository(async (repository) => {
    const disabledSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 81 };
    const enabledSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 82 };
    for (const [session, messageId, createdAt] of [
      [disabledSession, 'disabled-oldest', baseTime],
      [enabledSession, 'enabled-later', baseTime + 1],
    ] as const) {
      repository.insertPersonaMemo({
        account: groupSession.account,
        sessionId: sessionId(session),
        messageId,
        senderId: session.peer,
        senderName: '朋友',
        isSelf: false,
        text: messageId,
        createdAt,
      });
    }
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

    const result = await service.organizeAtSleep({
      account: groupSession.account,
      cycleKey: '2026-10-23',
      now: baseTime + 2_000,
    });
    assert.equal(result.status, 'partial');
    assert.deepEqual(processedSessions, [sessionId(enabledSession)]);
    assert.deepEqual(repository.listPendingPersonaMemos(groupSession.account, 10).map(({ messageId }) => messageId), ['disabled-oldest']);
  });
});

test('duplicate delivery retries a memo write that failed after the message was saved', async () => {
  await withRepository(async (repository, personaRoot) => {
    const insertMemo = repository.insertPersonaMemo.bind(repository);
    let failNextMemoWrite = true;
    repository.insertPersonaMemo = (memo) => {
      if (failNextMemoWrite) {
        failNextMemoWrite = false;
        throw new Error('temporary memo write failure');
      }
      return insertMemo(memo);
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
    assert.equal(repository.listPersonaMemos(groupSession.account, 10).length, 0);
    await pipeline(message);

    assert.deepEqual(repository.listPersonaMemos(groupSession.account, 10).map(({ messageId }) => messageId), ['memo-write-retry']);
  });
});

test('running-cycle recovery merges resumed memo sources into an existing diary', async () => {
  await withRepository(async (repository) => {
    const firstSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 82 };
    const secondSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 83 };
    for (const [session, messageId, text, createdAt] of [
      [firstSession, 'recover-first', '第一个来源已经处理。', baseTime],
      [secondSession, 'recover-second', '第二个来源恢复后处理。', baseTime + 1],
    ] as const) {
      repository.insertPersonaMemo({
        account: groupSession.account,
        sessionId: sessionId(session),
        messageId,
        senderId: session.peer,
        senderName: '朋友',
        isSelf: false,
        text,
        createdAt,
      });
    }

    const markProcessed = repository.markPersonaMemosProcessed.bind(repository);
    const finishRun = repository.finishPersonaMemoryRun.bind(repository);
    let interruptMark = true;
    let interruptFinish = true;
    repository.markPersonaMemosProcessed = (...args) => {
      if (interruptMark) {
        interruptMark = false;
        throw new Error('simulated interruption before memo readback');
      }
      return markProcessed(...args);
    };
    repository.finishPersonaMemoryRun = (input) => {
      if (interruptFinish) {
        interruptFinish = false;
        throw new Error('simulated interruption before run finalization');
      }
      finishRun(input);
    };
    let failSecondSessionOnce = true;
    const interruptedService = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async (session) => {
        if (sessionId(session) === sessionId(secondSession) && failSecondSessionOnce) {
          failSecondSessionOnce = false;
          return 'failed';
        }
        return 'done';
      },
    });
    await assert.rejects(interruptedService.organizeAtSleep({
      account: groupSession.account,
      cycleKey: '2026-10-23',
      now: baseTime + 2_000,
    }), /simulated interruption/u);
    assert.equal(repository.personaMemoryRun(groupSession.account, '2026-10-23')?.status, 'running');

    repository.markPersonaMemosProcessed = markProcessed;
    repository.finishPersonaMemoryRun = finishRun;
    const resumedService = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async () => 'done',
    });
    const resumed = await resumedService.organizeAtSleep({
      account: groupSession.account,
      cycleKey: '2026-10-23',
      now: baseTime + 3_000,
    });

    assert.equal(resumed.status, 'done');
    const diary = repository.listPersonaDiaries(groupSession.account, 10)[0];
    assert.equal(diary?.sourceCount, 2);
    assert.match(diary?.text ?? '', /第二个来源恢复后处理/u);
  });
});

test('emoji-heavy memo truncation respects the repository UTF-16 length limit', async () => {
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

    assert.equal(memory.recordMemo(message), true);
    const memo = repository.listPersonaMemos(groupSession.account, 1)[0];
    assert.equal(memo?.text.length, 2_000);
    assert.equal(memo?.text, '😀'.repeat(1_000));
  });
});

test('running-cycle recovery respects the total per-cycle memo limit', async () => {
  await withRepository(async (repository) => {
    const cycleKey = '2026-10-23';
    for (let index = 0; index < 1_001; index += 1) {
      repository.insertPersonaMemo({
        account: groupSession.account,
        sessionId: sessionId(groupSession),
        messageId: `recovered-limit-${index}`,
        senderId: 82,
        senderName: '群友',
        isSelf: false,
        text: `已存 memo ${index}`,
        createdAt: baseTime + index,
      });
    }
    assert.equal(repository.startPersonaMemoryRun({
      account: groupSession.account,
      cycleKey,
      memoCount: 1_001,
      startedAt: baseTime,
    }), true);
    const firstBatch = repository.listPendingPersonaMemos(groupSession.account, 1_000);
    assert.equal(repository.markPersonaMemosProcessed(groupSession.account, firstBatch.map(({ id }) => id), cycleKey), 1_000);
    repository.insertPersonaDiary({
      account: groupSession.account,
      cycleKey,
      text: 'first batch diary',
      sourceEntries: firstBatch.map((memo) => ({
        sessionId: memo.sessionId,
        messageId: memo.messageId,
        senderName: memo.senderName,
        text: memo.text,
        createdAt: memo.createdAt,
      })),
      sourceCount: firstBatch.length,
      createdAt: baseTime,
    });
    let processCalls = 0;
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async () => { processCalls += 1; return 'done'; },
    });

    const result = await service.organizeAtSleep({
      account: groupSession.account,
      cycleKey,
      now: baseTime + 2_000,
    });

    assert.equal(result.status, 'partial');
    assert.equal(processCalls, 0);
    assert.equal(repository.listPendingPersonaMemos(groupSession.account, 10).length, 1);
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
