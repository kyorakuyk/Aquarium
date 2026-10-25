import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonaMemorySegmentProcessor, createQueuedPersonaMemoryProcessor } from '../src/app/persona-memory-processor.ts';
import { createSessionQueue } from '../src/core/conversation/session-queue.ts';
import { createPersonaMemoryService } from '../src/core/persona-memory.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { baseTime, groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

test('session disabled while queued is not processed and does not block other sessions', async () => {
  await withRepository(async (repository) => {
    const disabledSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 81 };
    const enabledSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 82 };
    for (const [session, messageId, createdAt] of [
      [disabledSession, 'queued-disabled', baseTime],
      [enabledSession, 'queued-enabled', baseTime + 1],
    ] as const) {
      const targetSessionId = sessionId(session);
      repository.saveMessage({
        sessionId: targetSessionId,
        messageId,
        senderId: session.peer,
        senderName: '朋友',
        isSelf: false,
        plainText: messageId,
        segments: [],
        time: createdAt,
      });
      repository.savePersonaMemoryCursor({
        account: groupSession.account,
        sessionId: targetSessionId,
        organizedUntilMessageTime: null,
        openSegmentStart: createdAt,
      });
    }

    let releaseBlocker!: () => void;
    let markBlockerStarted!: () => void;
    let markFirstTaskQueued!: () => void;
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    const blockerStarted = new Promise<void>((resolve) => { markBlockerStarted = resolve; });
    const firstTaskQueued = new Promise<void>((resolve) => { markFirstTaskQueued = resolve; });
    let disabledSessionEnabled = true;
    const isSessionEnabled = (session: SessionKey): boolean =>
      sessionId(session) !== sessionId(disabledSession) || disabledSessionEnabled;
    const processedSessions: string[] = [];
    let blockFirstCall = true;
    const processor = createQueuedPersonaMemoryProcessor({
      isSessionEnabled,
      process: async (session) => {
        if (blockFirstCall) {
          blockFirstCall = false;
          markBlockerStarted();
          await blocker;
          return 'done';
        }
        processedSessions.push(sessionId(session));
        return 'done';
      },
    });
    const blockerTask = processor(disabledSession, [], baseTime);
    await blockerStarted;
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      canProcessSession: isSessionEnabled,
      processSession: (session, records, now) => {
        if (sessionId(session) === sessionId(disabledSession)) markFirstTaskQueued();
        return processor(session, records, now);
      },
    });
    const organizing = service.organizeAtSleep({
      account: groupSession.account,
      cycleKey: '2026-10-23',
      now: baseTime + 2_000,
    });
    await firstTaskQueued;
    disabledSessionEnabled = false;
    releaseBlocker();

    await blockerTask;
    const result = await organizing;
    assert.equal(result.status, 'partial');
    assert.deepEqual(processedSessions, [sessionId(enabledSession)]);
    assert.deepEqual(repository.listPersonaMemoryCursorSummaries(groupSession.account)
      .filter(({ pendingMessageCount }) => pendingMessageCount > 0)
      .map(({ sessionId: pendingSession }) => pendingSession), [sessionId(disabledSession)]);
  });
});

test('sleep memory processing does not hold the foreground session queue', async () => {
  const foregroundQueue = createSessionQueue();
  let release!: () => void;
  let markStarted!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const processor = createQueuedPersonaMemoryProcessor({
    isSessionEnabled: () => true,
    process: async () => {
      markStarted();
      await blocker;
      return 'done';
    },
  });
  const backgroundTask = processor(groupSession, [], baseTime);
  await started;

  let foregroundCompleted = false;
  await foregroundQueue.run(sessionId(groupSession), async () => { foregroundCompleted = true; });
  assert.equal(foregroundCompleted, true);
  release();
  assert.equal(await backgroundTask, 'done');
});

test('one segment extraction maps stored group events and private facts into scoped memo drafts', async () => {
  await withRepository(async (repository) => {
    const now = baseTime + 10_000;
    const groupRecords = ['group-start', 'group-end'].map((messageId, index) => ({
      sessionId: sessionId(groupSession),
      messageId,
      senderId: 42,
      senderName: '群友',
      isSelf: false,
      plainText: `群内计划 ${index}`,
      segments: [],
      time: baseTime + index,
    }));
    const eventId = repository.upsertGroupEvent({
      account: groupSession.account,
      sourceGroupId: groupSession.peer,
      anchorMessageId: 'group-start',
      title: '周末看展',
      summary: '群友约好周末看展。',
      participantIds: [42],
      evidenceMessageIds: ['group-start', 'group-end'],
      occurredAt: baseTime,
      createdAt: now,
      updatedAt: now,
    });
    const privateSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 42 };
    repository.insertPrivateFact({
      account: groupSession.account,
      ownerId: privateSession.peer,
      sessionId: sessionId(privateSession),
      text: '周末想去看展。',
      keywords: ['周末', '看展'],
      level: 'L1',
      levelSource: 'manual',
      mentions: 0,
      mentionEvidence: [],
      evidence: [{ messageId: 'private-start', time: baseTime + 20, quote: '周末想去看展' }],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    let groupExtractCalls = 0;
    let privateExtractCalls = 0;
    const processor = createPersonaMemorySegmentProcessor({
      repository,
      impressionsService: {
        tryAcquireSession: () => () => {},
        extractWindowUnderSessionLock: async () => {
          groupExtractCalls += 1;
          return { status: 'done' };
        },
      } as never,
      privateFactsService: {
        extractWindowUnderSessionLock: async () => {
          privateExtractCalls += 1;
          return {
            account: groupSession.account,
            sessionId: sessionId(privateSession),
            status: 'done',
            inserted: 0,
            updated: 0,
            deleted: 0,
            dropped: 0,
          };
        },
      } as never,
      privateMentionService: { maybePromote() {}, async idle() {} } as never,
      getConfig: () => makeConfig(),
      getTemplates: () => ({}) as never,
    });
    const mentionSegments = [{ type: 'at', target: groupSession.account }];
    const mentionSessionId = sessionId(groupSession);
    assert.equal(repository.saveMessage({
      sessionId: mentionSessionId,
      messageId: 'mention-only',
      senderId: 42,
      senderName: '群友',
      isSelf: false,
      plainText: '看一下这个。',
      segments: mentionSegments,
      time: baseTime + 30,
    }), true);
    repository.savePersonaMemoryCursor({
      account: groupSession.account,
      sessionId: mentionSessionId,
      organizedUntilMessageTime: null,
      openSegmentStart: baseTime + 30,
    });
    const pendingMention = repository.listPersonaMemoryPendingMessages(groupSession.account, mentionSessionId)[0]!;
    const persistedSegments: unknown = Reflect.get(pendingMention, 'segments');
    assert.deepEqual(persistedSegments, mentionSegments);
    assert.equal(processor.isSignificantSegment(groupSession, [{
      ...pendingMention,
      sessionId: mentionSessionId,
      segments: Array.isArray(persistedSegments) ? persistedSegments : [],
    }]), true);

    const groupResult = await processor.process(groupSession, groupRecords, now);
    assert.equal(groupExtractCalls, 1);
    assert.deepEqual(groupResult, {
      status: 'done',
      memos: [{
        account: groupSession.account,
        sessionId: sessionId(groupSession),
        eventId,
        title: '周末看展',
        summary: '群友约好周末看展。',
        participantIds: [42],
        startMessageId: 'group-start',
        endMessageId: 'group-end',
        level: 'L0',
        createdAt: now,
      }],
    });

    const privateResult = await processor.process(privateSession, [{
      sessionId: sessionId(privateSession),
      messageId: 'private-start',
      senderId: privateSession.peer,
      senderName: '朋友',
      isSelf: false,
      plainText: '周末想去看展。',
      segments: [],
      time: baseTime + 20,
    }], now);
    assert.equal(privateExtractCalls, 1);
    assert.deepEqual(privateResult, {
      status: 'done',
      memos: [{
        account: groupSession.account,
        sessionId: sessionId(privateSession),
        eventId: null,
        title: '周末、看展',
        summary: '周末想去看展。',
        participantIds: [privateSession.peer],
        startMessageId: 'private-start',
        endMessageId: 'private-start',
        level: 'L1',
        createdAt: now,
      }],
    });
  });
});
