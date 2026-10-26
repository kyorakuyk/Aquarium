import assert from 'node:assert/strict';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { createPersonaMemoryService } from '../src/core/persona-memory.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { createSleepWakeState } from '../src/core/sleep/index.ts';
import { makeConfig, groupSession, makeIncoming, withRepository } from './pipeline-test-helpers.ts';
import { saveAndObserveMessage } from './persona-memory-test-utils.ts';
import { createPersonaMemoryRuntime } from '../src/app/persona-memory-runtime.ts';

test('wake-word backlog schedules only messages older than the immediate twenty-message context', async () => {
  await withRepository(async (repository) => {
    const baseConfig = makeConfig();
    const config = AquariumConfigSchema.parse({
      ...baseConfig,
      sleep: { ...baseConfig.sleep, enabled: true, bedtime: '22:00', wake: '10:00', wakeWords: ['醒醒'] },
    });
    const bedAt = new Date(2026, 9, 18, 22).getTime();
    const wakeAt = new Date(2026, 9, 19, 10).getTime();
    const now = new Date(2026, 9, 19, 6, 59).getTime();
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => config,
      processSession: async () => 'done',
    });
    const backlogIds: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const messageId = `sleep-backlog-${index}`;
      backlogIds.push(messageId);
      assert.equal(saveAndObserveMessage(repository, service, makeIncoming({
        session: groupSession,
        messageId,
        senderId: 42,
        plainText: `较早积压${index}`,
        time: bedAt + (index + 1) * 20 * 60_000,
      })), true);
    }
    assert.equal(saveAndObserveMessage(repository, service, makeIncoming({
      session: groupSession,
      messageId: 'wake-word-message',
      senderId: config.owner,
      plainText: '小鱼，醒醒',
      mentionsSelf: true,
      time: now,
    })), true);

    const schedule = (service as unknown as {
      scheduleWakeWordBacklog?: (input: {
        session: typeof groupSession;
        cycleKey: string;
        wakeMessageId: string;
        bedAt: number;
        wakeAt: number;
        now: number;
      }) => boolean;
    }).scheduleWakeWordBacklog;
    assert.equal(typeof schedule, 'function');
    assert.equal(schedule?.call(service, {
      session: groupSession,
      cycleKey: '2026-10-18',
      wakeMessageId: 'wake-word-message',
      bedAt,
      wakeAt,
      now,
    }), true);

    const listPending = (repository as unknown as {
      listPendingPersonaMemoryWakeWordJobs?: (account: number, at: number, limit: number) => Array<{
        messageIds: string[];
        nextAttemptAt: number;
        expiresAt: number;
      }>;
    }).listPendingPersonaMemoryWakeWordJobs;
    assert.equal(typeof listPending, 'function');
    const [job] = listPending?.(groupSession.account, now + 10 * 60_000, 10) ?? [];
    assert.deepEqual(job?.messageIds, backlogIds.slice(0, 5));
    assert.equal(job?.nextAttemptAt, now + 10 * 60_000);
    assert.equal(job?.expiresAt, now + 6 * 60 * 60_000);
    assert.equal(job && repository.personaMemoryCursor(groupSession.account, sessionId(groupSession))?.organizedUntilMessageTime, null);

    const sleepWakeState = createSleepWakeState();
    sleepWakeState.activate(now);
    const dispatched: string[][] = [];
    const makeRuntime = (clock: number) => createPersonaMemoryRuntime({
      repository,
      getConfig: () => config,
      getTemplates: () => ({}) as never,
      impressionsService: {
        tryAcquireSession: () => () => {},
        extractWindowUnderSessionLock: async () => ({ status: 'done', persistedGroupEvents: [] }),
      } as never,
      privateFactsService: {} as never,
      privateMentionService: { maybePromote() {}, async idle() {} } as never,
      dispatchWakeFollowup: async (_message, options) => {
        dispatched.push(options.sleepFollowup?.messages.map(({ plainText }) => plainText) ?? []);
        return { replied: true, reason: 'replied' };
      },
      sleepWakeState,
      now: () => clock,
    });

    repository.saveMessage({
      sessionId: sessionId(groupSession),
      messageId: 'wakeword-later-chat',
      senderId: 43,
      senderName: '另一位群友',
      isSelf: false,
      plainText: '醒来后继续聊。',
      segments: [],
      time: now + 9 * 60_000,
    });
    const earlyRuntime = makeRuntime(now + 9 * 60_000);
    const stopEarly = earlyRuntime.start();
    await earlyRuntime.idle();
    stopEarly();
    assert.equal(dispatched.length, 0);

    repository.enqueuePersonaMemoryWakeFollowup({
      account: groupSession.account,
      sessionId: sessionId(groupSession),
      cycleKey: '2026-10-18',
      messageIds: [backlogIds[0]!],
      mentionIds: [42],
      createdAt: now + 18 * 60_000,
      nextAttemptAt: now + 19 * 60_000,
      expiresAt: now + 30 * 60_000,
    });

    const dueRuntime = makeRuntime(now + 10 * 60_000);
    const stopDue = dueRuntime.start();
    await dueRuntime.idle();
    stopDue();
    assert.equal(dispatched.length, 0);

    const silenceRuntime = makeRuntime(now + 19 * 60_000);
    const stopSilence = silenceRuntime.start();
    await silenceRuntime.idle();
    stopSilence();
    assert.deepEqual(dispatched, [
      ['较早积压0'],
      ['较早积压1', '较早积压2', '较早积压3', '较早积压4'],
    ]);
    assert.equal(repository.listPendingPersonaMemoryWakeWordJobs(groupSession.account, now + 10 * 60_000, 10).length, 0);
  });
});
