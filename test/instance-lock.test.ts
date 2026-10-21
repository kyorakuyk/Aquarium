import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireInstanceLock,
  INSTANCE_LOCK_HEARTBEAT_MS,
  INSTANCE_LOCK_STALE_MS,
} from '../src/app/instance-lock.ts';

function createFakeIntervals() {
  let callback: (() => void) | undefined;
  let delayMs = 0;
  return {
    set(callbackValue: () => void, delay: number): ReturnType<typeof setInterval> {
      callback = callbackValue;
      delayMs = delay;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clear(): void { callback = undefined; },
    tick(): void { callback?.(); },
    get delayMs(): number { return delayMs; },
  };
}

function createRoot(t: { after(callback: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-instance-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('活动锁拒绝第二个实例；两次心跳停滞后可接管且旧 owner 不会删新锁', (t) => {
  const root = createRoot(t);
  const lockPath = path.join(root, 'data', 'aquarium.lock');
  const ownerIntervals = createFakeIntervals();
  let now = 1_000;
  let ownerLost = 0;
  const owner = acquireInstanceLock({
    lockPath,
    pid: 101,
    now: () => now,
    isProcessAlive: () => true,
    setInterval: ownerIntervals.set,
    clearInterval: ownerIntervals.clear,
    onLost: () => { ownerLost += 1; },
  });
  assert.equal(owner.allowed, true);
  assert.equal(owner.degraded, false);
  assert.equal(ownerIntervals.delayMs, INSTANCE_LOCK_HEARTBEAT_MS);

  const activeAttempt = acquireInstanceLock({
    lockPath,
    pid: 202,
    now: () => now,
    isProcessAlive: () => true,
  });
  assert.equal(activeAttempt.allowed, false);

  now += INSTANCE_LOCK_HEARTBEAT_MS;
  ownerIntervals.tick();
  const refreshed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; heartbeatAt: number };
  assert.equal(refreshed.pid, 101);
  assert.equal(refreshed.heartbeatAt, now);

  now += INSTANCE_LOCK_STALE_MS - 1;
  assert.equal(acquireInstanceLock({
    lockPath,
    pid: 202,
    now: () => now,
    isProcessAlive: () => true,
  }).allowed, false);
  now += 1;
  const takeoverIntervals = createFakeIntervals();
  const takeover = acquireInstanceLock({
    lockPath,
    pid: 202,
    now: () => now,
    isProcessAlive: () => true,
    setInterval: takeoverIntervals.set,
    clearInterval: takeoverIntervals.clear,
  });
  assert.equal(takeover.allowed, true);
  assert.equal(takeover.degraded, false);
  assert.equal((JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number }).pid, 202);

  ownerIntervals.tick();
  assert.equal(ownerLost, 1);
  owner.release();
  assert.equal((JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number }).pid, 202);
  takeover.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('无法写入锁文件时降级放行并记录原因', (t) => {
  const root = createRoot(t);
  const blockingFile = path.join(root, 'not-a-directory');
  fs.writeFileSync(blockingFile, 'fixture');
  const logs: string[] = [];
  const result = acquireInstanceLock({
    lockPath: path.join(blockingFile, 'aquarium.lock'),
    pid: 303,
    onLog: (_level, message) => logs.push(message),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.degraded, true);
  assert.ok(logs.some((message) => message.includes('锁文件') && message.includes('降级')));
  result.release();
});
