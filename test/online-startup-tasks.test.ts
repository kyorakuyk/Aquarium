import assert from 'node:assert/strict';
import test from 'node:test';
import { createOnlineStartupTasks } from '../src/app/online-startup-tasks.ts';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('runs catch-up before sticker sync and coalesces startup tasks for 30 seconds', async () => {
  let now = 1_700_000_000_000;
  const historyGate = deferred();
  const calls: string[] = [];
  const runOnlineStartupTasks = createOnlineStartupTasks({
    catchUpHistory: async () => {
      calls.push('history');
      await historyGate.promise;
    },
    syncStickers: async () => { calls.push('stickers'); },
    now: () => now,
  });

  const firstOnline = runOnlineStartupTasks();
  const repeatedOnline = runOnlineStartupTasks();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['history']);

  historyGate.resolve();
  await Promise.all([firstOnline, repeatedOnline]);
  assert.deepEqual(calls, ['history', 'stickers']);

  now += 10_000;
  await runOnlineStartupTasks();
  assert.deepEqual(calls, ['history', 'stickers']);

  now += 20_001;
  await runOnlineStartupTasks();
  assert.deepEqual(calls, ['history', 'stickers', 'history', 'stickers']);
});
