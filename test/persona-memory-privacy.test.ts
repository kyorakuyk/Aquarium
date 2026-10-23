import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonaMemoryService } from '../src/core/persona-memory.ts';
import { baseTime, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

test('persona memos redact credential-shaped sender names before persistence', async () => {
  await withRepository(async (repository) => {
    const fakeToken = ['FAKE', '_TOKEN', '_VALUE', '_123456'].join('');
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async () => 'done',
    });
    const message = {
      ...makeIncoming({ session: groupSession, messageId: 'credential-name', senderId: 82, time: baseTime }),
      senderName: `token=${fakeToken}`,
    };

    assert.equal(service.recordMemo(message), true);
    const memo = repository.listPersonaMemos(groupSession.account, 10)
      .find(({ messageId }) => messageId === 'credential-name');
    assert.equal(memo?.senderName, '[敏感内容已隐藏]');
  });
});
