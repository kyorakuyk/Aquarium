import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionListMessage } from '../panel/src/session-list-state.ts';

test('session list distinguishes loading, empty, populated, and failed states', () => {
  assert.equal(sessionListMessage('loading', 0), '正在读取会话…');
  assert.equal(sessionListMessage('ready', 0), '没有找到会话。');
  assert.equal(sessionListMessage('ready', 2), undefined);
  assert.equal(sessionListMessage('error', 0), '会话列表暂不可用；请查看上方提示。');
});
