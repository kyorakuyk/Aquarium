import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAppHash, serializeAppHash } from '../panel/src/hash-navigation.ts';

test('页面与印象选择可在 URL hash 中往返编码', () => {
  const state = { page: 'impressions' as const, sessionId: '123:group:456', userId: 789 };
  const hash = serializeAppHash(state);
  assert.equal(hash, '#/impressions?sessionId=123%3Agroup%3A456&userId=789');
  assert.deepEqual(parseAppHash(hash), state);
});

test('未知页面回退给调用方，忽略无效或不适用的选择参数', () => {
  assert.equal(parseAppHash('#/unknown'), undefined);
  assert.deepEqual(parseAppHash('#/impressions?sessionId=123%3Agroup%3A456&userId=bad'), {
    page: 'impressions',
    sessionId: '123:group:456',
  });
  assert.deepEqual(parseAppHash('#/usage?sessionId=123%3Agroup%3A456&userId=789'), { page: 'usage' });
  assert.equal(serializeAppHash({ page: 'overview' }), '#/overview');
});
