import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMoodEvent } from '../src/store/affect-repo.ts';
import { buildMoodSeriesPoints } from '../src/core/mood/series.ts';
import { recoverReserve } from '../src/core/mood/core.ts';

const minute = 60_000;

test('series starts from the configured initial reserve when no anchor exists', () => {
  const input = {
    from: 0,
    to: 0,
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    energySource: 'mixed' as const,
    baseline: { valence: 0.1, arousal: 0.4 },
    events: [],
    replyTimes: [],
    initialReserve: 0.42,
  } as Parameters<typeof buildMoodSeriesPoints>[0] & { initialReserve: number };

  assert.equal(buildMoodSeriesPoints(input)[0]?.reserve, 0.42);
});

test('budget-skipped appraisal is excluded from companionship during series replay', () => {
  const to = 14 * minute;
  const budgetEvent: StoredMoodEvent = {
    id: 1,
    account: 900000001,
    time: minute,
    source: 'appraise',
    sessionId: '900000001:group:123456',
    senderId: 42,
    dv: 0,
    da: 0,
    appliedDv: 0,
    appliedDa: 0,
    reason: 'budget',
    bandBefore: null,
    bandAfter: null,
    valenceAfter: 0.1,
    arousalAfter: 0.4,
    dr: 0,
    appliedDr: 0,
    absorbed: 0,
    reserveAfter: 0.63,
    appraisalValid: false,
  };
  const point = buildMoodSeriesPoints({
    from: 0,
    to,
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    energySource: 'outer',
    initialReserve: 0.8,
    baseline: { valence: 0.1, arousal: 0.4 },
    previous: { time: 0, valenceAfter: 0.1, arousalAfter: 0.4, reserveAfter: 0.63 },
    events: [budgetEvent],
    replyTimes: [0],
  }).find((item) => item.time === to);

  const expected = recoverReserve({
    reserve: 0.63,
    energySource: 'outer',
    elapsedMs: 13 * minute,
    company: false,
    sad: false,
  });
  assert.ok(Math.abs((point?.reserve ?? 0) - expected) < 1e-9);
});

test('series uses the actual reply time across a reply without its own appraisal', () => {
  const from = 0;
  const replyTime = 43.5 * minute;
  const appraisalTime = 45 * minute;
  const to = 60 * minute;
  const reserveAtAppraisal = recoverReserve({
    reserve: 0.2,
    energySource: 'outer',
    elapsedMs: appraisalTime - from,
    company: false,
    sad: false,
  });
  const appraisal: StoredMoodEvent = {
    id: 1,
    account: 900000001,
    time: appraisalTime,
    source: 'appraise',
    sessionId: '900000001:group:123456',
    senderId: 42,
    dv: 0,
    da: 0,
    appliedDv: 0,
    appliedDa: 0,
    reason: '被认真关心',
    bandBefore: null,
    bandAfter: null,
    valenceAfter: 0.1,
    arousalAfter: 0.4,
    dr: 0,
    appliedDr: 0,
    absorbed: 0,
    reserveAfter: reserveAtAppraisal,
    appraisalValid: true,
  };
  const input = {
    from,
    to,
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    energySource: 'outer' as const,
    initialReserve: 0.8,
    baseline: { valence: 0.1, arousal: 0.4 },
    previous: { time: from, valenceAfter: 0.1, arousalAfter: 0.4, reserveAfter: 0.2 },
    events: [appraisal],
    replyTimes: [replyTime],
  } as Parameters<typeof buildMoodSeriesPoints>[0] & { replyTimes: readonly number[] };

  const point = buildMoodSeriesPoints(input).find((item) => item.time === to);
  const afterRecentCompany = recoverReserve({
    reserve: reserveAtAppraisal,
    energySource: 'outer',
    elapsedMs: 13.5 * minute,
    company: true,
    sad: false,
  });
  const expected = recoverReserve({
    reserve: afterRecentCompany,
    energySource: 'outer',
    elapsedMs: 1.5 * minute,
    company: false,
    sad: false,
  });
  const incorrectIfAppraisalTimeWereUsedAsReply = recoverReserve({
    reserve: reserveAtAppraisal,
    energySource: 'outer',
    elapsedMs: 15 * minute,
    company: true,
    sad: false,
  });

  assert.ok(Math.abs((point?.reserve ?? 0) - expected) < 1e-9);
  assert.ok((point?.reserve ?? 1) < incorrectIfAppraisalTimeWereUsedAsReply);
});
