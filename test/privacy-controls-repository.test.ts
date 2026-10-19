import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import { account, now, withPanel } from './panel-test-helpers.ts';

function fact(patch: Partial<Omit<PrivateFactRecord, 'id'>> = {}): Omit<PrivateFactRecord, 'id'> {
  return {
    account,
    ownerId: 42,
    sessionId: `${account}:private:42`,
    text: '最近在准备考研，压力较大',
    keywords: ['考研', '压力'],
    level: 'L1',
    levelSource: 'auto',
    mentions: 2,
    mentionEvidence: [],
    evidence: [{ messageId: 'private-source', time: now - 1000, quote: '最近有些压力' }],
    status: 'active',
    createdAt: now - 1000,
    updatedAt: now - 1000,
    ...patch,
  };
}

test('private fact controls update text and manual level, then restore level from mention count', async () => {
  await withPanel(async ({ repository }) => {
    const id = repository.insertPrivateFact(fact());
    const manual = repository.updatePrivateFactControls({
      account,
      ownerId: 42,
      id,
      text: '最近在准备新的职业资格考试',
      level: 'L2',
      promoteMentions: 3,
      updatedAt: now,
    });
    assert.equal(manual?.text, '最近在准备新的职业资格考试');
    assert.equal(manual?.level, 'L2');
    assert.equal(manual?.levelSource, 'manual');

    const restored = repository.updatePrivateFactControls({
      account,
      ownerId: 42,
      id,
      auto: true,
      promoteMentions: 3,
      updatedAt: now + 1,
    });
    assert.equal(restored?.level, 'L1');
    assert.equal(restored?.levelSource, 'auto');

    const promoted = repository.updatePrivateFactControls({
      account,
      ownerId: 42,
      id,
      auto: true,
      promoteMentions: 2,
      updatedAt: now + 2,
    });
    assert.equal(promoted?.level, 'L2');
  });
});

test('private fact control update is active-owner scoped and validates edits', async () => {
  await withPanel(async ({ repository }) => {
    const id = repository.insertPrivateFact(fact());
    assert.equal(repository.updatePrivateFactControls({
      account: account + 1,
      ownerId: 42,
      id,
      level: 'L2',
      promoteMentions: 3,
      updatedAt: now,
    }), undefined);
    assert.equal(repository.updatePrivateFactControls({
      account,
      ownerId: 43,
      id,
      level: 'L2',
      promoteMentions: 3,
      updatedAt: now,
    }), undefined);
    assert.throws(() => repository.updatePrivateFactControls({
      account,
      ownerId: 42,
      id,
      text: '短',
      promoteMentions: 3,
      updatedAt: now,
    }));

    repository.markPrivateFactDeleted(id, now);
    assert.equal(repository.updatePrivateFactControls({
      account,
      ownerId: 42,
      id,
      level: 'L2',
      promoteMentions: 3,
      updatedAt: now + 1,
    }), undefined);
    assert.equal(repository.privateFactById(id)?.status, 'deleted');
  });
});
