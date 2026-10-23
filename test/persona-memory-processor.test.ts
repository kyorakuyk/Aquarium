import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueuedPersonaMemoryProcessor } from '../src/app/persona-memory-processor.ts';
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
    assert.deepEqual(repository.listPendingPersonaMemos(groupSession.account, 10).map(({ messageId }) => messageId), ['queued-disabled']);
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
