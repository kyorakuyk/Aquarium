import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { createAccountActivityRouter } from '../src/app/activity-routing.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../src/core/shared/events.ts';
import { createSessionQueue } from '../src/core/conversation/session-queue.ts';
import type { RoutedActivityOptions } from '../src/core/activity/router.ts';

const baseConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const session: SessionKey = { account: 7, kind: 'group', peer: 9 };
const key = sessionId(session);
const ownerId = 11;

function makeConfig(options: { mode?: 'mention_only' | 'natural' | 'active' | 'busy'; owner?: number } = {}) {
  return AquariumConfigSchema.parse({
    ...baseConfig,
    owner: options.owner ?? 0,
    defaults: { ...baseConfig.defaults, enabled: true, nicknames: [] },
    sessions: { ...baseConfig.sessions, [key]: { mode: options.mode ?? 'active' } },
  });
}

function message(messageId: string, plainText = messageId, mentionsSelf = false): IncomingMessage {
  return {
    session,
    messageId,
    senderId: ownerId,
    senderName: 'Sender',
    segments: [{ type: 'text', text: plainText }],
    plainText,
    mentionsSelf,
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
    clearTimer(id: number) { timers.delete(id); },
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

function createHarness(options: {
  config?: ReturnType<typeof makeConfig>;
  isMuted?: boolean;
  costToday?: number;
} = {}) {
  const clock = fakeTimers();
  const queue = createSessionQueue();
  const handled: string[] = [];
  const processed: Array<{ messageId: string; options: RoutedActivityOptions }> = [];
  const management = {
    isMuted: () => options.isMuted ?? false,
    handle: async (incoming: IncomingMessage) => {
      if (incoming.plainText !== '/aq ping') return false;
      handled.push(incoming.messageId);
      return true;
    },
  };
  const router = createAccountActivityRouter({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    queue,
    getConfig: () => options.config ?? makeConfig(),
    management,
    costToday: () => options.costToday ?? 0,
    processMessage: async (incoming, routedOptions) => {
      processed.push({ messageId: incoming.messageId, options: routedOptions });
    },
  });
  return { clock, handled, processed, queue, router };
}

test('account routing keeps quiet-window work outside the session queue and resets it for new messages', async () => {
  const harness = createHarness();
  harness.router.route(message('first'));
  await harness.queue.idle();
  assert.deepEqual(harness.processed, []);

  harness.clock.advanceTo(5_000);
  harness.router.route(message('second'));
  await harness.queue.idle();
  harness.clock.advanceTo(8_000);
  await harness.queue.idle();
  assert.deepEqual(harness.processed, []);

  harness.clock.advanceTo(13_000);
  await harness.queue.idle();
  assert.deepEqual(harness.processed.map(({ messageId, options }) => ({
    messageId,
    batched: options.batched,
    batchIds: options.activityBatch?.messages.map((entry) => entry.messageId),
  })), [
    { messageId: 'first', batched: true, batchIds: undefined },
    { messageId: 'second', batched: undefined, batchIds: ['first', 'second'] },
  ]);
  harness.router.close();
});

test('a called message flushes a pending batch and is processed immediately', async () => {
  const harness = createHarness();
  harness.router.route(message('ordinary'));
  harness.clock.advanceTo(1_000);
  harness.router.route(message('called', 'Aquarium?', true));
  await harness.queue.idle();

  assert.deepEqual(harness.processed.map(({ messageId, options }) => [messageId, options.batched]), [
    ['ordinary', true],
    ['called', undefined],
  ]);
  assert.equal(harness.clock.timerCount(), 0);
  harness.router.close();
});

test('mention-only messages and recognized management commands bypass batching', async () => {
  const mentionOnly = createHarness({ config: makeConfig({ mode: 'mention_only' }) });
  mentionOnly.router.route(message('mention-only'));
  await mentionOnly.queue.idle();
  assert.equal(mentionOnly.processed.length, 1);
  assert.equal(mentionOnly.processed[0]?.options.activityBatch, undefined);
  mentionOnly.router.close();

  const command = createHarness({ config: makeConfig({ owner: ownerId }) });
  command.router.route(message('owner-command', '/aq ping'));
  await command.queue.idle();
  assert.deepEqual(command.handled, ['owner-command']);
  assert.deepEqual(command.processed, []);
  command.router.close();
});

test('disabled, muted, and over-budget sessions do not enter a quiet window', async () => {
  const disabledConfig = AquariumConfigSchema.parse({
    ...makeConfig(),
    defaults: { ...makeConfig().defaults, enabled: false },
  });
  const disabled = createHarness({ config: disabledConfig });
  disabled.router.route(message('disabled'));
  await disabled.queue.idle();
  assert.equal(disabled.processed.length, 1);
  assert.equal(disabled.clock.timerCount(), 0);
  disabled.router.close();

  const muted = createHarness({ isMuted: true });
  muted.router.route(message('muted'));
  await muted.queue.idle();
  assert.equal(muted.processed.length, 1);
  assert.equal(muted.clock.timerCount(), 0);
  muted.router.close();

  const overBudgetConfig = AquariumConfigSchema.parse({
    ...makeConfig(),
    budget: { ...baseConfig.budget, dailyCny: 0.001 },
  });
  const overBudget = createHarness({ config: overBudgetConfig, costToday: 0.002 });
  // The app helper receives the current spend through costToday; a positive sentinel
  // crosses the tiny fixture budget and must route directly to the budget gate.
  overBudget.router.route(message('over-budget'));
  await overBudget.queue.idle();
  assert.equal(overBudget.processed.length, 1);
  assert.equal(overBudget.clock.timerCount(), 0);
  overBudget.router.close();
});

test('closing account routing cancels pending timers and drains queued records as batched', async () => {
  const harness = createHarness();
  harness.router.route(message('pending-at-shutdown'));
  assert.equal(harness.clock.timerCount(), 1);

  harness.router.close();
  await harness.queue.idle();

  assert.equal(harness.clock.timerCount(), 0);
  assert.deepEqual(harness.processed.map(({ messageId, options }) => [messageId, options.batched]), [
    ['pending-at-shutdown', true],
  ]);
  harness.router.route(message('after-close'));
  await harness.queue.idle();
  assert.equal(harness.processed.length, 1);
});
