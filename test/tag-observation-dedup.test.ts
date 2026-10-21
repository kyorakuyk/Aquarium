import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTagObservation } from '../src/core/impressions/tags.ts';
import type { StoredTag } from '../src/store/affect-repo.ts';

const existing: StoredTag = {
  id: 1,
  account: 7,
  sessionId: '7:group:8',
  userId: null,
  text: '喜欢解谜游戏',
  norm: '喜欢解谜游戏',
  category: 'topic',
  subject: null,
  polarity: null,
  origin: 'inferred',
  locked: false,
  status: 'candidate',
  source: 'auto',
  samples: 2,
  evidence: [{ messageId: 'same-message', time: 10, quote: '原始证据' }],
  firstSeen: 10,
  lastSeen: 10,
  supersededBy: null,
  updatedAt: 10,
};

test('重复 messageId 不增加 samples、不追加 evidence，也不刷新 lastSeen', () => {
  const result = applyTagObservation([existing], {
    text: existing.text,
    messageId: 'same-message',
    time: 99,
    quote: '重复导入得到的不同引文',
  });

  assert.deepEqual(result, { action: 'ignore', reason: 'duplicate' });
  assert.equal(existing.samples, 2);
  assert.deepEqual(existing.evidence, [{ messageId: 'same-message', time: 10, quote: '原始证据' }]);
  assert.equal(existing.lastSeen, 10);
});
