import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateLimiter } from '../src/core/rate-limit.ts';
import type { SessionKey } from '../src/core/events.ts';

const firstSession: SessionKey = { account: 1, kind: 'group', peer: 100 };
const secondSession: SessionKey = { account: 1, kind: 'group', peer: 200 };
const limits = { perUserPerMinute: 1, perSessionPerMinute: 2, minIntervalSec: 0.5 };

test('rate limiter 按账号内用户跨会话限制每分钟消息数', () => {
  let now = 10_000;
  const limiter = createRateLimiter(() => now);

  assert.deepEqual(limiter.check(firstSession, 7, limits), { allowed: true });
  assert.deepEqual(limiter.check(secondSession, 7, limits), {
    allowed: false,
    reason: 'per_user_per_minute',
  });
  now += 60_001;
  assert.deepEqual(limiter.check(secondSession, 7, limits), { allowed: true });
});

test('rate limiter 分别限制会话每分钟次数和最小发送间隔', () => {
  let now = 20_000;
  const limiter = createRateLimiter(() => now);
  const sessionLimits = { ...limits, perUserPerMinute: 10, perSessionPerMinute: 2 };

  assert.deepEqual(limiter.check(firstSession, 7, sessionLimits), { allowed: true });
  now += 500;
  assert.deepEqual(limiter.check(firstSession, 8, sessionLimits), { allowed: true });
  now += 500;
  assert.deepEqual(limiter.check(firstSession, 9, sessionLimits), {
    allowed: false,
    reason: 'per_session_per_minute',
  });
});

test('rate limiter 正好达到最小间隔且滑动窗口过期后恢复', () => {
  let now = 30_000;
  const limiter = createRateLimiter(() => now);
  const shortWindow = { ...limits, perUserPerMinute: 2, perSessionPerMinute: 10 };

  assert.deepEqual(limiter.check(firstSession, 7, shortWindow), { allowed: true });
  now += 499;
  assert.deepEqual(limiter.check(firstSession, 7, shortWindow).reason, 'min_interval');
  now += 1;
  assert.deepEqual(limiter.check(firstSession, 7, shortWindow), { allowed: true });
  now += 60_000;
  assert.deepEqual(limiter.check(firstSession, 7, shortWindow), { allowed: true });
});
