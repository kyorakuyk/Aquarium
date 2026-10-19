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
    evidence: [{ messageId: 'private-1', time: 1, quote: '最近在准备考研，压力较大' }],
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

test('private facts and privacy run cursors persist and read back without cross-owner leakage', async () => {
  await withRepository(async (repository) => {
    for (const message of [
      { messageId: 'owner-message', senderId: 42, isSelf: false },
      { messageId: 'bot-message', senderId: groupSession.account, isSelf: true },
      { messageId: 'other-message', senderId: 43, isSelf: false },
    ]) {
      repository.saveMessage({
        sessionId: `${groupSession.account}:private:42`,
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: 'sender',
        isSelf: message.isSelf,
        plainText: 'a private message',
        segments: [],
        time: 5,
      });
    }
    assert.equal(repository.countPrivateOwnerMessagesAfter(`${groupSession.account}:private:42`, 42, 1), 1);

    const firstId = repository.insertPrivateFact(fact());
    const otherId = repository.insertPrivateFact(fact({ ownerId: 43, text: '喜欢周末爬山' }));

    assert.deepEqual(repository.listPrivateFactsForOwner(groupSession.account, 42), [
      { id: firstId, ...fact() },
    ]);
    assert.equal(repository.privateFactById(otherId)?.ownerId, 43);

    repository.updatePrivateFact(firstId, {
      text: '考研计划有进展',
      keywords: ['考研', '计划'],
      evidence: [{ messageId: 'private-2', time: 2, quote: '已经开始复习了' }],
      updatedAt: 2,
    });
    assert.deepEqual(repository.privateFactById(firstId), {
      id: firstId,
      ...fact({
        text: '考研计划有进展',
        keywords: ['考研', '计划'],
        evidence: [{ messageId: 'private-2', time: 2, quote: '已经开始复习了' }],
        updatedAt: 2,
      }),
    });

    repository.markPrivateFactDeleted(firstId, 3);
    assert.equal(repository.listPrivateFactsForOwner(groupSession.account, 42).length, 0);
    assert.equal(repository.privateFactById(firstId)?.status, 'deleted');

    repository.savePrivacyRun({
      account: groupSession.account,
      sessionId: `${groupSession.account}:private:42`,
      lastRunAt: 4,
      lastMessageTime: 3,
    });
    assert.deepEqual(repository.getPrivacyRun(groupSession.account, `${groupSession.account}:private:42`), {
      account: groupSession.account,
      sessionId: `${groupSession.account}:private:42`,
      lastRunAt: 4,
      lastMessageTime: 3,
    });
    repository.savePrivacyRun({
      account: groupSession.account,
      sessionId: `${groupSession.account}:private:42`,
      lastRunAt: null,
      lastMessageTime: null,
    });
    assert.equal(repository.getPrivacyRun(groupSession.account, `${groupSession.account}:private:42`)?.lastRunAt, null);
  });
});
