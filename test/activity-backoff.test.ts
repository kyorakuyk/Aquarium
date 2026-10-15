import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdleBackoff, idleBackoffDelayMs } from '../src/core/activity/backoff.ts';

test('idle backoff grows from the second no-reply result and caps at five minutes', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map(idleBackoffDelayMs),
    [0, 0, 15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000],
  );
});

test('idle backoff waits from the last judgment and permits work at the exact deadline', () => {
  const backoff = createIdleBackoff();
  const sessionId = 'account:group:1';
  backoff.recordNoReply(sessionId, 1_000);
  assert.equal(backoff.shouldBackoff(sessionId, 100_000, 1), false);

  backoff.recordNoReply(sessionId, 10_000);
  assert.equal(backoff.shouldBackoff(sessionId, 24_999, 1), true);
  assert.equal(backoff.shouldBackoff(sessionId, 25_000, 1), false);
});

test('a batch of six or more bypasses idle backoff without resetting its counter', () => {
  const backoff = createIdleBackoff();
  const sessionId = 'account:group:1';
  backoff.recordNoReply(sessionId, 0);
  backoff.recordNoReply(sessionId, 1_000);

  assert.equal(backoff.shouldBackoff(sessionId, 2_000, 5), true);
  assert.equal(backoff.shouldBackoff(sessionId, 2_000, 6), false);
  assert.equal(backoff.shouldBackoff(sessionId, 2_000, 8), false);
  assert.equal(backoff.shouldBackoff(sessionId, 2_000, 1), true);
});

test('a reply resets only that session idle backoff state', () => {
  const backoff = createIdleBackoff();
  backoff.recordNoReply('account:group:1', 0);
  backoff.recordNoReply('account:group:1', 1_000);
  backoff.recordNoReply('account:group:2', 0);
  backoff.recordNoReply('account:group:2', 1_000);

  backoff.recordReply('account:group:1');

  assert.equal(backoff.shouldBackoff('account:group:1', 2_000, 1), false);
  assert.equal(backoff.shouldBackoff('account:group:2', 2_000, 1), true);
  backoff.recordNoReply('account:group:1', 3_000);
  assert.equal(backoff.shouldBackoff('account:group:1', 100_000, 1), false);
});
