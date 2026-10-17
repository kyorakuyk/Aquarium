import assert from 'node:assert/strict';
import test from 'node:test';
import { nextLevel } from '../src/core/hysteresis.ts';

const params = {
  bounds: [10, 20],
  staticMargin: 2,
  slidingMargin: 1,
  slidingWindowMs: 100,
  decayDwellMs: 100,
} as const;

test('nextLevel applies friction margins and allows crossing multiple levels', () => {
  const staticState = { current: 0, since: 0, lastChangeAt: 0 };
  assert.equal(nextLevel(staticState, 11, 150, 'event', params), 0);
  assert.equal(nextLevel(staticState, 12, 150, 'event', params), 1);
  assert.equal(nextLevel(staticState, 30, 150, 'event', params), 2);

  const slidingState = { current: 1, since: 0, lastChangeAt: 100 };
  assert.equal(nextLevel(slidingState, 9, 150, 'event', params), 1);
  assert.equal(nextLevel(slidingState, 8, 150, 'event', params), 0);
});

test('nextLevel enforces dwell for decay but not events', () => {
  const youngState = { current: 1, since: 50, lastChangeAt: 0 };
  assert.equal(nextLevel(youngState, 30, 149, 'decay', params), 1);
  assert.equal(nextLevel(youngState, 30, 149, 'event', params), 2);
  assert.equal(nextLevel({ ...youngState, since: 49 }, 30, 149, 'decay', params), 2);
});
