import assert from 'node:assert/strict';
import test from 'node:test';
import { startProfileActivitySchedule } from '../src/app/profile-activity.ts';

function nextFourAm(now: number): number {
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

test('作息统计启动时补算，并按本地时间每天 04:00 重算', async () => {
  let now = new Date(2026, 5, 10, 3, 0, 0, 0).getTime();
  const runs: number[] = [];
  let scheduled: { callback: () => void; delayMs: number } | undefined;
  let cleared = 0;
  const service = {
    recomputeSchedules: async (at = now) => { runs.push(at); },
  };
  const stop = startProfileActivitySchedule({
    service,
    now: () => now,
    setTimer: (callback, delayMs) => {
      scheduled = { callback, delayMs };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => { cleared += 1; },
  });

  assert.deepEqual(runs, [now]);
  assert.equal(scheduled?.delayMs, nextFourAm(now) - now);
  now = nextFourAm(now);
  scheduled?.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, [new Date(2026, 5, 10, 3).getTime(), now]);
  assert.equal(scheduled?.delayMs, nextFourAm(now) - now);

  stop();
  assert.equal(cleared, 1);
});
