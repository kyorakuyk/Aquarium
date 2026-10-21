import assert from 'node:assert/strict';
import test from 'node:test';
import { createOnlineStartupTasks } from '../src/app/online-startup-tasks.ts';

function deferred(): { promise: Promise<boolean>; resolve: (value: boolean) => void } {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

function createFakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  return {
    pending,
    set(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear(timer: ReturnType<typeof setTimeout>): void {
      pending.delete(timer as unknown as number);
    },
    runNext(): number | undefined {
      const next = pending.entries().next();
      if (next.done) return undefined;
      const [id, timer] = next.value;
      pending.delete(id);
      timer.callback();
      return timer.delay;
    },
  };
}

test('重复 online 合并在途任务，且补课先于表情同步', async () => {
  const historyGate = deferred();
  const calls: string[] = [];
  const runOnlineStartupTasks = createOnlineStartupTasks({
    catchUpHistory: async () => {
      calls.push('history');
      return historyGate.promise;
    },
    syncStickers: async () => { calls.push('stickers'); },
  });

  const firstOnline = runOnlineStartupTasks();
  const repeatedOnline = runOnlineStartupTasks();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['history']);

  historyGate.resolve(true);
  await Promise.all([firstOnline, repeatedOnline]);
  assert.deepEqual(calls, ['history', 'stickers']);
  runOnlineStartupTasks.close();
});

test('补课失败后 10 秒再次上线会重试，不从失败开始冷却', async () => {
  let now = 1_700_000_000_000;
  let attempts = 0;
  const runOnlineStartupTasks = createOnlineStartupTasks({
    catchUpHistory: async () => ++attempts > 1,
    syncStickers: async () => {},
    now: () => now,
  });

  await runOnlineStartupTasks();
  assert.equal(attempts, 1);
  now += 10_000;
  await runOnlineStartupTasks();
  assert.equal(attempts, 2);
  runOnlineStartupTasks.close();
});

test('冷却期内被跳过的上线触发会在冷却结束后合并补跑一次', async () => {
  let now = 0;
  const timers = createFakeTimers();
  let attempts = 0;
  let delayedRunFinished!: () => void;
  const delayedRun = new Promise<void>((resolve) => { delayedRunFinished = resolve; });
  const runOnlineStartupTasks = createOnlineStartupTasks({
    catchUpHistory: async () => {
      attempts += 1;
      if (attempts === 2) delayedRunFinished();
      return true;
    },
    syncStickers: async () => {},
    now: () => now,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  await runOnlineStartupTasks();
  now = 10_000;
  await runOnlineStartupTasks();
  now = 15_000;
  await runOnlineStartupTasks();
  assert.equal(attempts, 1);
  assert.deepEqual([...timers.pending.values()].map((timer) => timer.delay), [20_000]);

  now = 30_000;
  assert.equal(timers.runNext(), 20_000);
  await delayedRun;
  assert.equal(attempts, 2);
  runOnlineStartupTasks.close();
});
