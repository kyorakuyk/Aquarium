import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonaMemoryScheduler } from '../src/core/memory/scheduler.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { baseTime, groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

function at(hour: number, minute: number): number {
  const date = new Date(baseTime);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

test('memory scheduling and cache cleanup preserve pending, unscoped, and other-account messages', async () => {
  await withRepository(async (repository) => {
    const account = groupSession.account;
    const privateSession: SessionKey = { account, kind: 'private', peer: 82 };
    const untrackedSession: SessionKey = { account, kind: 'private', peer: 83 };
    const otherAccountSession: SessionKey = { account: account + 1, kind: 'private', peer: 82 };
    const sessions = [groupSession, privateSession, untrackedSession, otherAccountSession];
    const messages = [
      [groupSession, 'a-old', baseTime],
      [groupSession, 'a-manual', baseTime + 100],
      [groupSession, 'a-tie', baseTime + 200],
      [groupSession, 'a-future', baseTime + 300],
      [privateSession, 'b-old', baseTime],
      [privateSession, 'b-manual', baseTime + 100],
      [untrackedSession, 'u-old', baseTime],
      [otherAccountSession, 'x-old', baseTime],
    ] as const;
    for (const [session, messageId, time] of messages) {
      assert.equal(repository.saveMessage({
        sessionId: sessionId(session),
        messageId,
        senderId: 42,
        senderName: '朋友',
        isSelf: false,
        plainText: messageId,
        segments: [],
        time,
      }), true);
    }
    repository.savePersonaMemoryCursor({
      account,
      sessionId: sessionId(groupSession),
      organizedUntilMessageTime: baseTime + 200,
      organizedUntilMessageRowId: null,
      openSegmentStart: null,
    });
    repository.savePersonaMemoryCursor({
      account,
      sessionId: sessionId(privateSession),
      organizedUntilMessageTime: baseTime + 200,
      organizedUntilMessageRowId: null,
      openSegmentStart: null,
    });
    repository.savePersonaMemoryTailMessages({
      account,
      sessionId: sessionId(groupSession),
      messages: [
        { messageId: 'a-old', createdAt: baseTime },
        { messageId: 'a-manual', createdAt: baseTime + 100 },
      ],
    });
    repository.savePersonaMemoryTailMessages({
      account,
      sessionId: sessionId(privateSession),
      messages: [
        { messageId: 'b-old', createdAt: baseTime },
        { messageId: 'b-manual', createdAt: baseTime + 100 },
      ],
    });

    assert.equal(repository.deleteOrganizedPersonaMemoryMessagesBefore(account, baseTime + 50), 2);
    assert.equal(repository.messageBySessionAndId(sessionId(groupSession), 'a-old'), undefined);
    assert.equal(repository.messageBySessionAndId(sessionId(privateSession), 'b-old'), undefined);
    assert.ok(repository.messageBySessionAndId(sessionId(groupSession), 'a-manual'));
    assert.ok(repository.messageBySessionAndId(sessionId(groupSession), 'a-tie'));
    assert.ok(repository.messageBySessionAndId(sessionId(untrackedSession), 'u-old'));
    assert.ok(repository.messageBySessionAndId(sessionId(otherAccountSession), 'x-old'));

    assert.equal(repository.clearOrganizedPersonaMemoryMessages(account, sessionId(groupSession)), 1);
    assert.equal(repository.messageBySessionAndId(sessionId(groupSession), 'a-manual'), undefined);
    assert.ok(repository.messageBySessionAndId(sessionId(groupSession), 'a-tie'));
    assert.ok(repository.messageBySessionAndId(sessionId(groupSession), 'a-future'));
    assert.equal(repository.clearOrganizedPersonaMemoryMessages(account), 1);
    assert.equal(repository.messageBySessionAndId(sessionId(privateSession), 'b-manual'), undefined);
    assert.ok(repository.messageBySessionAndId(sessionId(untrackedSession), 'u-old'));
    assert.ok(repository.messageBySessionAndId(sessionId(otherAccountSession), 'x-old'));
    assert.equal(repository.listPersonaMemoryTailMessages(account, 40).length, 0);

    let clock = at(3, 59);
    let config = makeConfig();
    const scheduled: Array<{ cycleKey: string; now: number }> = [];
    const tickTimes: number[] = [];
    const scheduler = createPersonaMemoryScheduler({
      getConfig: () => config,
      runCycle: async (cycleKey, now) => { scheduled.push({ cycleKey, now }); },
      onTick: async (now) => { tickTimes.push(now); },
      now: () => clock,
      intervalMs: 60_000,
    });
    await scheduler.tick();
    assert.deepEqual(scheduled, []);
    clock = at(4, 0);
    await scheduler.tick();
    assert.deepEqual(scheduled, [{ cycleKey: '2026-10-12', now: clock }]);
    await scheduler.tick();
    assert.equal(scheduled.length, 1);

    config.sleep.enabled = true;
    clock = at(22, 0);
    await scheduler.tick();
    assert.equal(scheduled.length, 1);
    await scheduler.onSleep('2026-10-12', clock);
    await scheduler.onSleep('2026-10-12', clock);
    assert.deepEqual(scheduled[1], { cycleKey: '2026-10-12', now: clock });
    assert.equal(scheduled.length, 2);
    assert.deepEqual(tickTimes, [at(3, 59), at(4, 0), at(4, 0), at(22, 0)]);

    let releaseFixedCycle: () => void = () => {};
    let markFixedCycleStarted: () => void = () => {};
    const fixedCycleGate = new Promise<void>((resolve) => { releaseFixedCycle = resolve; });
    const fixedCycleStarted = new Promise<void>((resolve) => { markFixedCycleStarted = resolve; });
    const blockConfig = makeConfig();
    const started: string[] = [];
    const serializedScheduler = createPersonaMemoryScheduler({
      getConfig: () => blockConfig,
      runCycle: async (cycleKey) => {
        started.push(cycleKey);
        if (started.length === 1) markFixedCycleStarted();
        if (cycleKey === '2026-10-12') await fixedCycleGate;
      },
      now: () => at(4, 0),
    });
    const fixedCycleTask = serializedScheduler.tick();
    await fixedCycleStarted;
    assert.deepEqual(started, ['2026-10-12']);
    blockConfig.sleep.enabled = true;
    const sleepCycleTask = serializedScheduler.onSleep('2026-10-13', at(22, 0));
    await Promise.resolve();
    assert.deepEqual(started, ['2026-10-12']);
    releaseFixedCycle();
    await Promise.all([fixedCycleTask, sleepCycleTask]);
    assert.deepEqual(started, ['2026-10-12', '2026-10-13']);
  });
});
