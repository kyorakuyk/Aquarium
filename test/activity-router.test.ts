import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivityMessageRouter } from '../src/core/activity/router.ts';
import { createSessionQueue } from '../src/core/conversation/session-queue.ts';
import type { IncomingMessage, SessionKey } from '../src/core/shared/events.ts';

const session: SessionKey = { account: 7, kind: 'group', peer: 9 };

function message(messageId: string): IncomingMessage {
  return {
    session,
    messageId,
    senderId: 11,
    senderName: 'Sender',
    segments: [{ type: 'text', text: messageId }],
    plainText: messageId,
    mentionsSelf: false,
    replyToSelf: false,
    time: 1_800_000_000_000,
  };
}

function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback: () => void, delayMs: number) {
      const id = ++nextId;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer(id: number) {
      timers.delete(id);
    },
    advanceTo(target: number) {
      now = target;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
    timerCount: () => timers.size,
  };
}

test('quiet-window 等待不占会话队列且队列外新消息可以重置计时', async () => {
  const clock = fakeTimers();
  const queue = createSessionQueue();
  const processed: Array<{ messageId: string; kind: 'batched' | 'activity'; batchIds?: string[] }> = [];
  const router = createActivityMessageRouter({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    queue,
    shouldBatch: () => true,
    processMessage: async (incoming, options) => {
      if (options.batched) {
        processed.push({ messageId: incoming.messageId, kind: 'batched' });
      } else {
        processed.push({
          messageId: incoming.messageId,
          kind: 'activity',
          batchIds: options.activityBatch?.messages.map((entry) => entry.messageId),
        });
      }
    },
  });

  router.route(message('first'));
  await queue.idle();
  assert.deepEqual(processed, []);
  assert.equal(clock.timerCount(), 1);

  clock.advanceTo(5_000);
  router.route(message('second'));
  await queue.idle();
  clock.advanceTo(8_000);
  await queue.idle();
  assert.deepEqual(processed, []);
  assert.equal(clock.timerCount(), 1);

  clock.advanceTo(13_000);
  await queue.idle();
  assert.deepEqual(processed, [
    { messageId: 'first', kind: 'batched' },
    { messageId: 'second', kind: 'activity', batchIds: ['first', 'second'] },
  ]);
  assert.equal(clock.timerCount(), 0);
  router.close();
});

test('timer setup failure processes the first message exactly once without a batched gate', async () => {
  const queue = createSessionQueue();
  const processed: Array<{ messageId: string; batched: boolean }> = [];
  let reported = 0;
  const router = createActivityMessageRouter({
    now: () => 0,
    setTimer: () => { throw new Error('timer unavailable'); },
    clearTimer: () => {},
    queue,
    shouldBatch: () => true,
    processMessage: async (incoming, options) => {
      processed.push({ messageId: incoming.messageId, batched: options.batched === true });
    },
    onError: () => { reported += 1; },
  });

  router.route(message('timer-failure'));
  await queue.idle();

  assert.deepEqual(processed, [{ messageId: 'timer-failure', batched: false }]);
  assert.equal(reported, 1);
  router.close();
});

test('timer reset failure preserves prior batch messages and routes the current message once', async () => {
  const queue = createSessionQueue();
  let timerCalls = 0;
  const processed: Array<{ messageId: string; batched: boolean }> = [];
  const router = createActivityMessageRouter({
    now: () => 0,
    setTimer: () => {
      timerCalls += 1;
      if (timerCalls === 2) throw new Error('timer unavailable');
      return timerCalls;
    },
    clearTimer: () => {},
    queue,
    shouldBatch: () => true,
    processMessage: async (incoming, options) => {
      processed.push({ messageId: incoming.messageId, batched: options.batched === true });
    },
  });

  router.route(message('previous'));
  router.route(message('current'));
  await queue.idle();

  assert.deepEqual(processed, [
    { messageId: 'previous', batched: true },
    { messageId: 'current', batched: false },
  ]);
  router.close();
});
