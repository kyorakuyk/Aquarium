import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const session = sessionId({ account: 7, kind: 'group', peer: 9 });

test('inner voice is stored separately from the bot message text and read back in order', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    repository.saveMessage({
      sessionId: session,
      messageId: 'bot-message',
      senderId: 7,
      senderName: 'Bot',
      isSelf: true,
      plainText: '真正发出的正文。',
      segments: [{ type: 'text', text: '真正发出的正文。' }],
      time: 100,
    });
    repository.saveInnerVoiceForMessage(session, 'bot-message', ['（心里一紧）', '（还是很在意）'], 100);
    assert.deepEqual(repository.innerVoiceForMessage(session, 'bot-message'), ['（心里一紧）', '（还是很在意）']);
    assert.equal(repository.messageBySessionAndId(session, 'bot-message')?.plainText, '真正发出的正文。');
  } finally {
    database.close();
  }
});
