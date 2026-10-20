import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';

test('sessionId 为群聊和私聊生成稳定唯一格式', () => {
  assert.equal(sessionId({ account: 900000001, kind: 'group', peer: 123456 }), '900000001:group:123456');
  assert.equal(sessionId({ account: 900000001, kind: 'private', peer: 42 }), '900000001:private:42');
});
