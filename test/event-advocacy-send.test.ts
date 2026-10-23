import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityThreshold } from '../src/core/activity/threshold.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { createRateLimiter } from '../src/core/shared/rate-limit.ts';
import { createSleepWakeState } from '../src/core/sleep/index.ts';
import { createRepository } from '../src/store/repository.ts';
import { openDatabase } from '../src/store/db.ts';
import { createEventAdvocacySender } from '../src/core/privacy/event-advocacy.ts';
import { baseTime, FakeAdapter, groupSession, makeConfig } from './pipeline-test-helpers.ts';

function prepareConfirmedAdvocacy(
  repository: ReturnType<typeof createRepository>,
  title: string,
  noteText: string,
  now: number,
): number {
  const eventId = repository.upsertGroupEvent({
    account: groupSession.account,
    sourceGroupId: groupSession.peer,
    anchorMessageId: `group-${title}`,
    title,
    summary: `群友约好${title}`,
    participantIds: [42],
    evidenceMessageIds: [`group-${title}`],
    occurredAt: now - 10,
    createdAt: now - 10,
    updatedAt: now - 10,
  });
  repository.upsertGroupEventNote({
    account: groupSession.account,
    eventId,
    ownerId: 42,
    sourceSessionId: `${groupSession.account}:private:42`,
    text: noteText,
    intent: 'advocate',
    level: 'L2',
    status: 'active',
    sourceMessageIds: [`private-${title}`],
    createdAt: now - 5,
    updatedAt: now - 5,
  });
  repository.ensureEventAdvocacyPending({
    account: groupSession.account,
    eventId,
    ownerId: 42,
    sourceSessionId: `${groupSession.account}:private:42`,
    requestedAt: now - 5,
  });
  repository.markEventAdvocacyPrompted({
    account: groupSession.account,
    eventId,
    ownerId: 42,
    promptMessageId: `prompt-${title}`,
    promptedAt: now - 4,
  });
  repository.confirmEventAdvocacy({
    account: groupSession.account,
    eventId,
    ownerId: 42,
    promptMessageId: `prompt-${title}`,
    confirmationMessageId: `yes-${title}`,
    confirmedAt: now - 3,
  });
  return eventId;
}

function activeConfig() {
  return makeConfig({ sessions: {
    [sessionId(groupSession)]: { enabled: true, mode: 'active' },
  } });
}

test('confirmed advocacy sends a redacted group message at most once', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const eventId = prepareConfirmedAdvocacy(repository, '周末漫展', '集合时间改为周日下午三点', baseTime);
    const adapter = new FakeAdapter();
    const config = activeConfig();
    const send = createEventAdvocacySender({
      repository,
      adapter,
      getConfig: () => config,
      getNickname: () => 'Aquarium',
      isMuted: () => false,
      isOnline: () => true,
      now: () => baseTime,
      activityThreshold: createActivityThreshold(),
      rateLimiter: createRateLimiter(() => baseTime),
      sleepWakeState: createSleepWakeState(),
    });

    assert.equal(await send(eventId), 'sent');
    assert.equal(adapter.sent.length, 1);
    assert.deepEqual(adapter.sent[0]?.session, groupSession);
    const text = adapter.sent[0]?.segments.find((segment) => segment.type === 'text');
    assert.equal(text?.type, 'text');
    if (text?.type === 'text') {
      assert.match(text.text, /周日下午三点/u);
      assert.doesNotMatch(text.text, /私聊|来源/u);
    }
    assert.equal(repository.eventAdvocacyByEvent(groupSession.account, eventId)?.status, 'sent');
    assert.equal(await send(eventId), 'blocked');
    assert.equal(adapter.sent.length, 1);
  } finally {
    database.close();
  }
});

test('advocacy waits for active mode, budget, sleep and proactive cooldown', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const nowBase = new Date(2026, 9, 12, 12, 0).getTime();
    const eventId = prepareConfirmedAdvocacy(repository, '桌游聚会', '周五晚上七点开始', nowBase);
    const adapter = new FakeAdapter();
    const config = activeConfig();
    let now = nowBase;
    const threshold = createActivityThreshold();
    threshold.recordProactiveReply(sessionId(groupSession), 'active', now - 10_000);
    const send = createEventAdvocacySender({
      repository,
      adapter,
      getConfig: () => config,
      getNickname: () => 'Aquarium',
      isMuted: () => false,
      isOnline: () => true,
      now: () => now,
      activityThreshold: threshold,
      rateLimiter: createRateLimiter(() => now),
      sleepWakeState: createSleepWakeState(),
    });

    config.budget.dailyCny = 0;
    assert.equal(await send(eventId), 'blocked');
    config.budget.dailyCny = 5;
    config.sleep.enabled = true;
    config.sleep.bedtime = '00:00';
    config.sleep.wake = '23:59';
    assert.equal(await send(eventId), 'blocked');
    config.sleep.enabled = false;
    assert.equal(await send(eventId), 'blocked');
    now += 200_000;
    assert.equal(await send(eventId), 'sent');
    assert.equal(adapter.sent.length, 1);
  } finally {
    database.close();
  }
});
