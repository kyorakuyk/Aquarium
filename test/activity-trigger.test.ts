import assert from 'node:assert/strict';
import test from 'node:test';
import { messageTrigger } from '../src/core/activity/trigger.ts';
import type { IncomingMessage, SessionKey } from '../src/core/shared/events.ts';

const group: SessionKey = { account: 7, kind: 'group', peer: 9 };

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    session: group,
    messageId: 'message-1',
    senderId: 11,
    senderName: 'Sender',
    segments: [{ type: 'text', text: 'hello' }],
    plainText: 'hello',
    mentionsSelf: false,
    replyToSelf: false,
    time: 1_800_000_000_000,
    ...overrides,
  };
}

test('messageTrigger distinguishes private, explicit mention, configured nickname, and no trigger', () => {
  assert.equal(messageTrigger(makeMessage({ session: { ...group, kind: 'private', peer: 11 } }), []), 'private');
  assert.equal(messageTrigger(makeMessage({ mentionsSelf: true }), []), 'mention');
  assert.equal(messageTrigger(makeMessage({ plainText: 'hey AquariumBot' }), [' ', 'AquariumBot']), 'nickname');
  assert.equal(messageTrigger(makeMessage(), ['AquariumBot']), 'none');
});
