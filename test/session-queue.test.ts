import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionQueue } from '../src/core/conversation/session-queue.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = () => resolvePromise(undefined);
  });
  return { promise, resolve };
}

test('同一会话的任务按到达顺序串行执行', async () => {
  const queue = createSessionQueue();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const events: string[] = [];

  const first = queue.run('account:group:1', async () => {
    events.push('first:start');
    firstStarted.resolve();
    await releaseFirst.promise;
    events.push('first:end');
  });
  await firstStarted.promise;
  const second = queue.run('account:group:1', async () => {
    events.push('second');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const eventsBeforeRelease = [...events];
  releaseFirst.resolve();
  await Promise.all([first, second]);
  await queue.idle();

  assert.deepEqual(eventsBeforeRelease, ['first:start']);
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});

test('不同会话的任务可以并行执行', async () => {
  const queue = createSessionQueue();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let secondStarted = false;

  const first = queue.run('account:group:1', async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;
  const second = queue.run('account:group:2', async () => {
    secondStarted = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const startedBeforeRelease = secondStarted;
  releaseFirst.resolve();
  await Promise.all([first, second]);

  assert.equal(startedBeforeRelease, true);
});

test('同一会话中前一个任务失败不会阻断后续任务', async () => {
  const queue = createSessionQueue();
  const events: string[] = [];
  const first = queue.run('account:private:1', async () => {
    events.push('first');
    throw new Error('task failed');
  });
  const second = queue.run('account:private:1', async () => {
    events.push('second');
  });

  await assert.rejects(first, /task failed/);
  await second;
  await queue.idle();

  assert.deepEqual(events, ['first', 'second']);
});

test('idle 等待所有会话的在途任务并在空队列时立即完成', async () => {
  const queue = createSessionQueue();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  let idleResolved = false;

  const first = queue.run('account:group:1', async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  const second = queue.run('account:group:2', async () => {
    secondStarted.resolve();
    await releaseSecond.promise;
  });
  await Promise.all([firstStarted.promise, secondStarted.promise]);
  const idle = queue.idle().then(() => { idleResolved = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(idleResolved, false);

  releaseFirst.resolve();
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(idleResolved, false);

  releaseSecond.resolve();
  await Promise.all([second, idle]);
  assert.equal(idleResolved, true);
  await queue.idle();
});
