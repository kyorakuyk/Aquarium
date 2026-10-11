import assert from 'node:assert/strict';
import test from 'node:test';
import { replyDelayMs } from '../src/core/pacing.ts';

test('replyDelayMs 按字数夹紧基准延迟后施加 0.8 到 1.3 抖动', () => {
  assert.equal(replyDelayMs('🌱', () => 0), 640);
  assert.equal(replyDelayMs('你好', () => 0.4), 840);
  assert.equal(replyDelayMs('长'.repeat(100), () => 0.4), 6_000);
  assert.equal(replyDelayMs('长'.repeat(100), () => 1), 7_800);
});
