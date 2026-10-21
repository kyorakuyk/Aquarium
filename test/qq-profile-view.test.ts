import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeQqMemberComposition } from '../src/core/profiles/qq-profile-view.ts';

const now = Date.UTC(2026, 9, 21);

test('QQ member composition counts sex and calendar-year join-duration buckets', () => {
  const composition = summarizeQqMemberComposition([
    { sex: 'male', joinTime: Date.UTC(2023, 9, 21) / 1_000 },
    { sex: 'female', joinTime: Date.UTC(2025, 9, 21) / 1_000 },
    { sex: 'male', joinTime: Date.UTC(2025, 9, 22) / 1_000 },
    { sex: 'unknown' },
    { joinTime: Date.UTC(2027, 0, 1) / 1_000 },
  ], now);

  assert.deepEqual(composition, {
    sex: { male: 2, female: 1, unknown: 2 },
    joinDuration: { overThreeYears: 1, oneToThreeYears: 1, withinOneYear: 1, unknown: 2 },
  });
});
