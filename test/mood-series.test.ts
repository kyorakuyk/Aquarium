import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMoodEvent } from '../src/store/affect-repo.ts';
import { buildMoodSeriesPoints, MOOD_SERIES_INTERVAL_MS } from '../src/core/mood/series.ts';
import { holdDecay, recoverReserve, surfaceHalfLifeMin } from '../src/core/mood/core.ts';
import { resolveMoodState } from '../src/core/mood/state.ts';

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

test('curve samples do not alter grid values and the endpoint matches resolved mood state', () => {
  const from = 0;
  const to = 80 * minute;
  const baseline = { valence: 0.1, arousal: 0.4 };
  const anchors = {
    valenceD0: 0.7,
    valenceU: 0.5,
    arousalD0: 0.35,
    arousalU: 0.25,
    dominanceD0: 0.2,
    dominanceU: 0.25,
  };
  const event: StoredMoodEvent = {
    id: 1,
    account: 900000001,
    time: from,
    source: 'rule',
    sessionId: '900000001:group:123456',
    senderId: null,
    dv: 0,
    da: 0,
    dd: 0,
    appliedDv: 0,
    appliedDa: 0,
    appliedDd: 0,
    dominanceAfter: holdDecay(anchors.dominanceD0, anchors.dominanceU, 2),
    valenceUAfter: anchors.valenceU,
    arousalUAfter: anchors.arousalU,
    dominanceUAfter: anchors.dominanceU,
    causeTag: null,
    reason: 'called',
    bandBefore: null,
    bandAfter: null,
    valenceAfter: baseline.valence + holdDecay(anchors.valenceD0, anchors.valenceU, 3),
    arousalAfter: baseline.arousal + holdDecay(anchors.arousalD0, anchors.arousalU, 2),
    dr: 0,
    appliedDr: 0,
    absorbed: 0,
    reserveAfter: 0.4,
    appraisalValid: null,
  };
  const input = {
    from,
    to,
    intervalMs: 15 * minute,
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    energySource: 'outer' as const,
    baseline,
    initialReserve: 0.4,
    events: [event],
    replyTimes: [],
  } as Parameters<typeof buildMoodSeriesPoints>[0] & { includeCurveSamples?: boolean };
  const withSamples = buildMoodSeriesPoints({ ...input, includeCurveSamples: true });
  const withoutSamples = buildMoodSeriesPoints({ ...input, includeCurveSamples: false });
  const t50ValenceMs = surfaceHalfLifeMin(0.4, 40) * minute;
  const t50ArousalMs = 40 * minute;
  const expectedCurveTimes = [
    Math.round(t50ValenceMs * (1 / 9) ** (1 / 3)),
    Math.round(t50ValenceMs),
    Math.round(t50ArousalMs * (1 / 9) ** (1 / 2)),
    Math.round(t50ArousalMs),
  ];
  const sampledTimes = new Set(withSamples.map((point) => point.time));
  assert.ok(expectedCurveTimes.every((time) => sampledTimes.has(time)));

  const withoutByTime = new Map(withoutSamples.map((point) => [point.time, point]));
  const withByTime = new Map(withSamples.map((point) => [point.time, point]));
  for (let time = from; time <= to; time += 15 * minute) {
    const expected = withoutByTime.get(time);
    const actual = withByTime.get(time);
    assert.ok(expected && actual, `missing grid point at ${time}`);
    for (const key of ['valence', 'arousal', 'dominance', 'reserve'] as const) {
      assert.ok(
        Math.abs(actual[key] - expected[key]) < 1e-12,
        `${key} at ${time}: sampled=${actual[key]}, gridOnly=${expected[key]}`,
      );
    }
  }

  const settings = {
    baseline,
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    reserve: { initial: 0.4 },
  } as Parameters<typeof resolveMoodState>[0]['settings'];
  const resolved = resolveMoodState({
    stored: {
      account: event.account,
      valence: event.valenceAfter ?? baseline.valence,
      arousal: event.arousalAfter ?? baseline.arousal,
      dominance: event.dominanceAfter ?? 0,
      ...anchors,
      updatedAt: from,
      band: 'calm',
      bandSince: from,
      lastBandChangeAt: from,
      mainEmotion: null,
      emotionSince: null,
      lastEmotionChangeAt: null,
      reserve: 0.4,
      reserveBand: 'full',
      reserveBandSince: from,
      reserveLastChangeAt: from,
      lastReplyAt: null,
    },
    at: to,
    settings,
    energySource: 'outer',
    appraisalEvents: [],
    replyTimes: [],
  });
  const last = withByTime.get(to);
  assert.ok(last);
  assert.ok(Math.abs(last.valence - resolved.valence) < 1e-12);
  assert.ok(Math.abs(last.arousal - resolved.arousal) < 1e-12);
  assert.ok(Math.abs(last.dominance - resolved.dominance) < 1e-12);
  assert.ok(Math.abs(last.reserve - resolved.reserve) < 1e-12);
});

test('series uses five-minute samples through 12 hours and fifteen minutes beyond', () => {
  const input = {
    from: 0,
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    energySource: 'mixed' as const,
    baseline: { valence: 0.1, arousal: 0.4 },
    initialReserve: 0.8,
    events: [],
    replyTimes: [],
  } as const;
  const short = buildMoodSeriesPoints({ ...input, to: 12 * 60 * minute });
  const long = buildMoodSeriesPoints({ ...input, to: 12 * 60 * minute + 15 * minute });

  assert.equal(MOOD_SERIES_INTERVAL_MS, 5 * minute);
  assert.equal(short.length, 145);
  assert.ok(short.some((point) => point.time === 5 * minute));
  assert.equal(long.length, 50);
  assert.ok(long.some((point) => point.time === 15 * minute));
  assert.equal(long.some((point) => point.time === 5 * minute), false);
});
