import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityBatcher, type ActivityBatch } from '../src/core/activity/batcher.ts';

function fakeClock() {
  let currentTime = 0;
  let nextId = 0;
  const timers = new Map<number, { dueAt: number; callback: () => void }>();

  return {
    now: () => currentTime,
    setTimer(callback: () => void, delayMs: number) {
      const id = nextId++;
      timers.set(id, { dueAt: currentTime + delayMs, callback });
      return id;
    },
    clearTimer(id: number) {
      timers.delete(id);
    },
    advance(milliseconds: number) {
      const target = currentTime + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        currentTime = timer.dueAt;
        timer.callback();
      }
      currentTime = target;
    },
    pendingTimers: () => timers.size,
  };
}

function makeBatcher(clock: ReturnType<typeof fakeClock>, flushed: ActivityBatch<string>[]) {
  return createActivityBatcher({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFlush: (batch) => flushed.push(batch),
  });
}

test('activity batch restarts the 8-second quiet window and keeps message order', () => {
  const clock = fakeClock();
  const flushed: ActivityBatch<string>[] = [];
  const batcher = makeBatcher(clock, flushed);

  batcher.add('account:group:1', 'first');
  clock.advance(7_000);
  batcher.add('account:group:1', 'last');
  clock.advance(7_999);
  assert.equal(flushed.length, 0);
  clock.advance(1);

  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0]?.messages, ['first', 'last']);
  assert.equal(flushed[0]?.latestMessage, 'last');
  assert.equal(flushed[0]?.startedAt, 0);
});

test('activity batch flushes at the 30-second hard cap despite continued messages', () => {
  const clock = fakeClock();
  const flushed: ActivityBatch<string>[] = [];
  const batcher = makeBatcher(clock, flushed);

  batcher.add('account:group:1', 'm0');
  for (const [index, time] of [7_000, 14_000, 21_000, 28_000].entries()) {
    clock.advance(time - clock.now());
    batcher.add('account:group:1', `m${index + 1}`);
  }
  clock.advance(1_999);
  assert.equal(flushed.length, 0);
  clock.advance(1);

  assert.equal(flushed.length, 1);
  assert.deepEqual(flushed[0]?.messages, ['m0', 'm1', 'm2', 'm3', 'm4']);
  assert.equal(flushed[0]?.latestMessage, 'm4');
});

test('cancel returns pending messages and prevents the timer from flushing them', () => {
  const clock = fakeClock();
  const flushed: ActivityBatch<string>[] = [];
  const batcher = makeBatcher(clock, flushed);

  batcher.add('account:group:1', 'first');
  clock.advance(2_000);
  batcher.add('account:group:1', 'second');
  const cancelled = batcher.cancel('account:group:1');

  assert.deepEqual(cancelled?.messages, ['first', 'second']);
  assert.equal(batcher.cancel('account:group:1'), undefined);
  assert.equal(clock.pendingTimers(), 0);
  clock.advance(60_000);
  assert.deepEqual(flushed, []);
});

test('a message arriving after a deadline starts a new batch', () => {
  const clock = fakeClock();
  const flushed: ActivityBatch<string>[] = [];
  const batcher = makeBatcher(clock, flushed);

  batcher.add('account:group:1', 'first');
  clock.advance(8_000);
  batcher.add('account:group:1', 'second');
  clock.advance(7_999);
  assert.equal(flushed.length, 1);
  clock.advance(1);

  assert.equal(flushed.length, 2);
  assert.deepEqual(flushed[0]?.messages, ['first']);
  assert.deepEqual(flushed[1]?.messages, ['second']);
});
