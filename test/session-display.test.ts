import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionOptionLabel, sessionPeerLabel } from '../panel/src/session-display.ts';

test('session labels show peer numbers and group counts without encoded account IDs', () => {
  const group = {
    sessionId: '2718002251:group:1004200446',
    kind: 'group' as const,
    memberCount: 17,
    name: '测试群',
  };
  const friend = {
    sessionId: '2718002251:private:123456789',
    kind: 'private' as const,
    name: '小林',
  };
  assert.equal(sessionPeerLabel(group), '1004200446 · 17 人');
  assert.equal(sessionOptionLabel(group), '测试群 · 1004200446 · 17 人');
  assert.equal(sessionPeerLabel(friend), '123456789');
  assert.equal(sessionOptionLabel(friend), '小林 · 123456789');
});
