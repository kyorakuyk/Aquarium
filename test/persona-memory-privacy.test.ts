import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonaMemoryService } from '../src/core/persona-memory.ts';
import { baseTime, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

test('observed private messages are not copied into the archived raw-memo table', async () => {
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

    repository.saveMessage({
      sessionId: `${groupSession.account}:group:${groupSession.peer}`,
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      isSelf: false,
      plainText: message.plainText,
      segments: [],
      time: message.time,
    });
    assert.equal(service.observeMessage(message), true);
    assert.equal(repository.listPersonaMemos(groupSession.account, 10).length, 0);
  });
});
