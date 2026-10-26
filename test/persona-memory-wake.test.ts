import assert from 'node:assert/strict';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { createPersonaMemoryService } from '../src/core/persona-memory.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { FakeAdapter, baseTime, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';
import { saveAndObserveMessage } from './persona-memory-test-utils.ts';
import { processPersonaMemoryWakeFollowups } from '../src/app/persona-memory-wake.ts';
import { createPersonaMemoryRuntime } from '../src/app/persona-memory-runtime.ts';

test('sleep organization is idempotent, writes one visible diary, and redacts its memo source', async () => {
  await withRepository(async (repository, personaRoot) => {
    const baseConfig = makeConfig();
    let config = AquariumConfigSchema.parse({
      ...baseConfig,
      sleep: { ...baseConfig.sleep, enabled: true, bedtime: '22:00', wake: '07:00', wakeWords: ['醒醒'], goodnight: false },
    });
    const bedAt = new Date(2026, 9, 12, 22).getTime();
    const wakeAt = new Date(2026, 9, 13, 7).getTime();
    const wakeNow = wakeAt + 1_000;
    const privateSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 82 };
    const sessionIds: string[] = [];
    let diaryCalls = 0;
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => config,
      processSession: async (session, records, now) => {
        sessionIds.push(sessionId(session));
        assert.ok(records.length > 0);
        const first = records[0]!;
        const last = records.at(-1)!;
        return {
          status: 'done',
          memos: [{
            account: session.account,
            sessionId: sessionId(session),
            eventId: null,
            title: '夜间记录',
            summary: records.map(({ plainText }) => plainText).join('；'),
            participantIds: [...new Set(records.filter(({ isSelf }) => !isSelf).map(({ senderId }) => senderId))],
            startMessageId: first.messageId,
            endMessageId: last.messageId,
            level: 'L0',
            createdAt: now,
          }],
        };
      },
      generateDiary: async ({ memos }) => {
        diaryCalls += 1;
        return { status: 'done', text: memos.map(({ title, summary }) => `${title}：${summary}`).join('\n') };
      },
    });
    const messages = [
      makeIncoming({
        session: groupSession,
        messageId: 'night-group-memo',
        senderId: 82,
        plainText: '今天说了一个尚待确认的计划。',
        time: baseTime,
      }),
      makeIncoming({
        session: privateSession,
        messageId: 'night-private-memo',
        senderId: privateSession.peer,
        plainText: 'access_token=ABCDEF123456',
        time: baseTime + 1,
      }),
    ];
    for (const message of messages) assert.equal(saveAndObserveMessage(repository, service, message), true);

    const cycleKey = '2026-10-12';
    const first = await service.organizeAtSleep({ account: groupSession.account, cycleKey, now: bedAt });
    const second = await service.organizeAtSleep({ account: groupSession.account, cycleKey, now: bedAt + 10 });
    assert.equal(first.status, 'done');
    assert.equal(second.status, 'already_run');
    assert.equal(diaryCalls, 1);
    assert.equal(sessionIds.length, 2);
    assert.equal(repository.listPersonaMemoryCursorSummaries(groupSession.account)
      .reduce((total, cursor) => total + cursor.pendingMessageCount, 0), 0);
    const diary = repository.listPersonaDiaries(groupSession.account, 10)[0];
    assert.ok(diary?.visibleToAni);
    assert.match(diary?.text ?? '', /\[敏感内容已隐藏\]/u);
    assert.doesNotMatch(diary?.text ?? '', /ABCDEF123456/u);
    assert.match(service.recentDiaryBlock(groupSession.account, groupSession, bedAt + 20) ?? '', /尚待确认/u);
    assert.equal(service.recentDiaryBlock(groupSession.account + 1, groupSession, bedAt + 20), undefined);
    assert.equal(repository.setPersonaDiaryVisibility(groupSession.account, diary!.id, false), true);
    assert.equal(service.recentDiaryBlock(groupSession.account, groupSession, bedAt + 20), undefined);

    const afterSleepMessages = [
      makeIncoming({
        session: groupSession,
        messageId: 'sleep-group-1',
        senderId: 84,
        plainText: '小鱼，睡着后有个新的计划。',
        time: bedAt + 30 * 60_000,
      }),
      makeIncoming({
        session: groupSession,
        messageId: 'sleep-group-2',
        senderId: 85,
        plainText: '小鱼，我也想补充一件事。',
        time: bedAt + 31 * 60_000,
      }),
      makeIncoming({
        session: privateSession,
        messageId: 'sleep-private-replied',
        senderId: privateSession.peer,
        plainText: '前一条私聊已经得到回复。',
        time: bedAt + 32 * 60_000,
      }),
      makeIncoming({
        session: privateSession,
        messageId: 'sleep-private-1',
        senderId: privateSession.peer,
        plainText: 'access_token=ABCDEF123456',
        time: bedAt + 33 * 60_000,
      }),
    ];
    for (const message of afterSleepMessages) assert.equal(saveAndObserveMessage(repository, service, message), true);
    repository.recordDecision({
      time: bedAt + 32 * 60_000 + 1,
      sessionId: sessionId(privateSession),
      messageId: 'sleep-private-replied',
      replied: true,
      reason: 'replied',
      detail: {},
    });
    const wakeResult = await service.organizeAtWake({
      account: groupSession.account,
      cycleKey,
      bedAt,
      wakeAt,
      now: wakeNow,
    });
    assert.equal(wakeResult.organized.status, 'done');
    assert.equal(wakeResult.contextCount, 2);
    assert.equal(wakeResult.followupCount, 2);
    assert.equal(diaryCalls, 1);
    assert.equal(sessionIds.length, 4);
    assert.equal(repository.listPersonaMemoryCursorSummaries(groupSession.account)
      .reduce((total, cursor) => total + cursor.pendingMessageCount, 0), 0);
    assert.ok(repository.listPersonaEventMemos(groupSession.account, 10)
      .some((memo) => memo.startMessageId === 'sleep-group-1'));

    const queued = repository.listPendingPersonaMemoryWakeFollowups(groupSession.account, wakeNow, 10);
    const groupFollowup = queued.find(({ sessionId: queuedSessionId }) => queuedSessionId === sessionId(groupSession));
    const privateFollowup = queued.find(({ sessionId: queuedSessionId }) => queuedSessionId === sessionId(privateSession));
    assert.deepEqual(groupFollowup?.messageIds, ['sleep-group-1', 'sleep-group-2']);
    assert.deepEqual(groupFollowup?.mentionIds, [84, 85]);
    assert.deepEqual(privateFollowup?.messageIds, ['sleep-private-1']);
    assert.deepEqual(privateFollowup?.mentionIds, []);

    const groupSleepBlock = service.sleepMemoryBlock(groupSession.account, groupSession, wakeNow);
    const privateSleepBlock = service.sleepMemoryBlock(groupSession.account, privateSession, wakeNow);
    assert.match(groupSleepBlock ?? '', /睡着后有个新的计划/u);
    assert.doesNotMatch(groupSleepBlock ?? '', /ABCDEF123456/u);
    assert.match(privateSleepBlock ?? '', /\[敏感内容已隐藏\]/u);
    assert.equal(service.sleepMemoryBlock(groupSession.account + 1, groupSession, wakeNow), undefined);
    assert.equal(service.sleepMemoryBlock(groupSession.account, groupSession, wakeNow + 6 * 60 * 60_000 + 1), undefined);

    const adapter = new FakeAdapter();
    const replyPrompts: string[] = [];
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      personaMemoryService: service,
      now: () => wakeNow,
      wait: async () => {},
      callModel: async (slot, modelMessages) => {
        if (slot === 'reply') {
          replyPrompts.push(modelMessages
            .map((message) => typeof message.content === 'string' ? message.content : '').join('\n'));
        }
        return {
          text: '醒来后我看到了，记下了。',
          provider: 'fake',
          model: 'fake-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const normalBudgetConfig = config;
    config = AquariumConfigSchema.parse({
      ...config,
      budget: { ...config.budget, dailyCny: 0 },
    });
    const budgetDispatch = await processPersonaMemoryWakeFollowups({
      repository,
      account: groupSession.account,
      now: wakeNow,
      dispatch: (message, options) => pipeline(message, options),
    });
    assert.deepEqual(budgetDispatch, { sent: 0, deferred: 2, skipped: 0, needsReview: 0 });
    assert.deepEqual(adapter.sent, []);
    config = normalBudgetConfig;
    const dispatch = await processPersonaMemoryWakeFollowups({
      repository,
      account: groupSession.account,
      now: wakeNow + 60_000,
      dispatch: (message, options) => pipeline(message, options),
    });
    assert.deepEqual(dispatch, { sent: 2, deferred: 0, skipped: 0, needsReview: 0 });
    assert.equal(adapter.sent.length, 2);
    const groupSend = adapter.sent.find(({ session }) => sessionId(session) === sessionId(groupSession));
    const privateSend = adapter.sent.find(({ session }) => sessionId(session) === sessionId(privateSession));
    assert.deepEqual(groupSend?.segments.filter((segment) => segment.type === 'at'), [
      { type: 'at', target: 84 },
      { type: 'at', target: 85 },
    ]);
    assert.ok(privateSend);
    assert.equal(replyPrompts.length, 2);
    assert.match(replyPrompts[0] ?? '', /睡眠期间|睡着期间/u);
    assert.doesNotMatch(replyPrompts[0] ?? '', /ABCDEF123456/u);
    assert.equal(repository.listPendingPersonaMemoryWakeFollowups(groupSession.account, wakeNow, 10).length, 0);
    assert.equal(repository.deleteExpiredPersonaMemorySleepContexts(groupSession.account, wakeNow + 6 * 60 * 60_000 + 1), 2);
    assert.equal(repository.deleteExpiredPersonaMemorySleepContexts(groupSession.account + 1, wakeNow + 6 * 60 * 60_000 + 1), 0);
  });
});

test('wake preparation merges the sleep batch before the periodic worker can claim it', async () => {
  await withRepository(async (repository) => {
    const now = Date.now();
    const bedAt = now - 60_000;
    const wakeAt = now - 1_000;
    const cycleKey = new Date(bedAt).toISOString().slice(0, 10);
    const targetSessionId = sessionId(groupSession);
    const segments = [{ type: 'at', target: groupSession.account }];
    for (const [messageId, text, time] of [
      ['sleep-existing', '较早睡眠消息', bedAt + 1_000],
      ['sleep-new', '后续睡眠消息', bedAt + 2_000],
    ] as const) {
      repository.saveMessage({
        sessionId: targetSessionId,
        messageId,
        senderId: 42,
        senderName: '群友',
        isSelf: false,
        plainText: text,
        segments,
        time,
      });
    }
    repository.savePersonaMemoryCursor({
      account: groupSession.account,
      sessionId: targetSessionId,
      organizedUntilMessageTime: null,
      openSegmentStart: bedAt + 1_000,
    });
    repository.enqueuePersonaMemoryWakeFollowup({
      account: groupSession.account,
      sessionId: targetSessionId,
      cycleKey,
      messageIds: ['sleep-existing'],
      mentionIds: [42],
      createdAt: now - 10_000,
      expiresAt: now + 6 * 60 * 60_000,
    });

    let markExtractionStarted: () => void = () => {};
    let releaseExtraction: () => void = () => {};
    let markDispatchStarted: () => void = () => {};
    let releaseDispatch: () => void = () => {};
    const extractionStarted = new Promise<void>((resolve) => { markExtractionStarted = resolve; });
    const extractionGate = new Promise<void>((resolve) => { releaseExtraction = resolve; });
    const dispatchStarted = new Promise<void>((resolve) => { markDispatchStarted = resolve; });
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    let dispatchCalls = 0;
    let dispatchedTexts: string[] = [];
    const runtime = createPersonaMemoryRuntime({
      repository,
      getConfig: () => makeConfig(),
      getTemplates: () => ({ extractTags: {} }) as never,
      impressionsService: {
        tryAcquireSession: () => () => {},
        extractWindowUnderSessionLock: async () => {
          markExtractionStarted();
          await extractionGate;
          return { status: 'done', persistedGroupEvents: [] };
        },
      } as never,
      privateFactsService: {} as never,
      privateMentionService: { maybePromote() {}, async idle() {} } as never,
      dispatchWakeFollowup: async (_message, processOptions) => {
        dispatchCalls += 1;
        dispatchedTexts = processOptions.sleepFollowup?.messages.map(({ plainText }) => plainText) ?? [];
        markDispatchStarted();
        await dispatchGate;
        return { replied: true, reason: 'replied' };
      },
    });

    const wakeTask = runtime.onWake(cycleKey, now, bedAt, wakeAt);
    const stop = runtime.start();
    try {
      assert.equal(dispatchCalls, 0);
      await extractionStarted;
      releaseExtraction();
      await dispatchStarted;
      assert.deepEqual(dispatchedTexts, ['较早睡眠消息', '后续睡眠消息']);
      releaseDispatch();
      await wakeTask;
    } finally {
      releaseExtraction();
      releaseDispatch();
      stop();
      await runtime.idle();
    }
  });
});
