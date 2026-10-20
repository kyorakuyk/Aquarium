import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import { groupSession, withRepository } from './pipeline-test-helpers.ts';

function fact(patch: Partial<Omit<PrivateFactRecord, 'id'>> = {}): Omit<PrivateFactRecord, 'id'> {
  return {
    account: groupSession.account,
    ownerId: 42,
    sessionId: `${groupSession.account}:private:42`,
    text: '最近在准备考研，压力较大',
    keywords: ['考研', '压力'],
    level: 'L0',
    levelSource: 'auto',
    mentions: 0,
    mentionEvidence: [],
    evidence: [],
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

test('a private fact is counted once per local day and auto level follows configured threshold', async () => {
  await withRepository(async (repository) => {
    const id = repository.insertPrivateFact(fact());
    const dayStart = new Date(2026, 9, 20, 0, 0, 0, 0).getTime();
    const nextDayStart = new Date(2026, 9, 21, 0, 0, 0, 0).getTime();
    const evidence = {
      sessionId: `${groupSession.account}:group:123`,
      messageId: 'group-mention-1',
      time: dayStart + 60 * 60_000,
    };
    const input = {
      account: groupSession.account,
      ownerId: 42,
      id,
      evidence,
      dayStart,
      nextDayStart,
      updatedAt: dayStart + 60 * 60_000,
      promoteMentions: 2,
    };

    const first = repository.recordPrivateFactMention(input);
    const repeated = repository.recordPrivateFactMention({
      ...input,
      evidence: { ...evidence, messageId: 'group-mention-2', time: dayStart + 2 * 60 * 60_000 },
      updatedAt: dayStart + 2 * 60 * 60_000,
    });
    const nextDay = repository.recordPrivateFactMention({
      ...input,
      evidence: { ...evidence, messageId: 'group-mention-3', time: nextDayStart + 60 * 60_000 },
      dayStart: nextDayStart,
      nextDayStart: new Date(2026, 9, 22, 0, 0, 0, 0).getTime(),
      updatedAt: nextDayStart + 60 * 60_000,
    });

    assert.equal(first.recorded, true);
    assert.equal(first.fact?.mentions, 1);
    assert.equal(first.fact?.level, 'L1');
    assert.equal(repeated.recorded, false);
    assert.equal(repeated.fact?.mentions, 1);
    assert.equal(nextDay.recorded, true);
    assert.equal(nextDay.fact?.mentions, 2);
    assert.equal(nextDay.fact?.level, 'L2');
    assert.deepEqual(nextDay.fact?.mentionEvidence.map(({ messageId }) => messageId), [
      'group-mention-1', 'group-mention-3',
    ]);
  });
});

test('manual privacy level is preserved when owner mentions are recorded', async () => {
  await withRepository(async (repository) => {
    const id = repository.insertPrivateFact(fact({ level: 'L0', levelSource: 'manual' }));
    const dayStart = new Date(2026, 9, 20, 0, 0, 0, 0).getTime();
    const result = repository.recordPrivateFactMention({
      account: groupSession.account,
      ownerId: 42,
      id,
      evidence: {
        sessionId: `${groupSession.account}:group:123`,
        messageId: 'manual-level-mention',
        time: dayStart + 60 * 60_000,
      },
      dayStart,
      nextDayStart: new Date(2026, 9, 21, 0, 0, 0, 0).getTime(),
      updatedAt: dayStart + 60 * 60_000,
      promoteMentions: 2,
    });

    assert.equal(result.recorded, true);
    assert.equal(result.fact?.mentions, 1);
    assert.equal(result.fact?.level, 'L0');
    assert.equal(result.fact?.levelSource, 'manual');
  });
});
