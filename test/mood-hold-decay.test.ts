import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceMoodState, holdDecay, reanchor, surfaceHalfLifeMin, type MoodDynamicsState } from '../src/core/mood/core.ts';
import { resolveMoodState } from '../src/core/mood/state.ts';

const minute = 60_000;

test('Hill 停留曲线从原值开始、T50 折半，n=1 退化为反比例曲线', () => {
  assert.equal(holdDecay(0.4, 0, 3), 0.4);
  assert.equal(holdDecay(0.4, 1, 3), 0.2);
  assert.equal(holdDecay(0.4, 2, 1), 0.4 / 3);
  assert.ok(holdDecay(1, 0.5, 3) > holdDecay(1, 1, 3));
  assert.ok(holdDecay(1, 1, 3) > holdDecay(1, 2, 3));
  assert.throws(() => holdDecay(1, -1, 3), RangeError);
});

test('reanchor 让新刺激和越过基线重新停留、安慰保持进度、归零清除锚点', () => {
  assert.deepEqual(reanchor(0.001, 0.2, 0.7, 3), { d0: 0.2, u: 0 });
  assert.deepEqual(reanchor(0.2, 0.4, 0.7, 3), { d0: 0.4, u: 0 });
  const comfort = reanchor(0.4, 0.2, 0.7, 3);
  assert.equal(comfort.u, 0.7);
  assert.ok(Math.abs(holdDecay(comfort.d0, comfort.u, 3) - 0.2) < 1e-12);
  assert.deepEqual(reanchor(0.3, -0.2, 0.7, 3), { d0: -0.2, u: 0 });
  assert.deepEqual(reanchor(0.3, 0.001, 0.7, 3), { d0: 0, u: 0 });
});

test('advanceMoodState 使用锚点 Hill 曲线且分四块推进与一次推进一致', () => {
  const start: MoodDynamicsState = { valence: 0.8, arousal: 0.9, dominance: 0.6, reserve: 1 };
  const options = {
    from: 0,
    to: 60 * minute,
    baseline: { valence: 0.1, arousal: 0.4 },
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    surfaceHoldShape: 3,
    arousalHoldShape: 2,
    energySource: 'inner' as const,
    energyMultipliers: { aloneRecovery: 0, calmRecoveryCost: 0 },
    lastReplyAt: null,
    companionshipPositive: false,
  } satisfies Parameters<typeof advanceMoodState>[1];
  const single = advanceMoodState(start, options);
  let chunked = start;
  for (let index = 0; index < 4; index += 1) {
    chunked = advanceMoodState(chunked, {
      ...options,
      from: index * 15 * minute,
      to: (index + 1) * 15 * minute,
    });
  }

  assert.ok(Math.abs(single.valence - (0.1 + holdDecay(0.7, 1.5, 3))) < 1e-9);
  assert.ok(Math.abs(single.arousal - (0.4 + holdDecay(0.5, 1.5, 2))) < 1e-9);
  assert.ok(Math.abs(single.dominance - holdDecay(0.6, 1.5, 2)) < 1e-9);
  assert.equal(single.valenceU, 1.5);
  assert.equal(single.arousalU, 1.5);
  assert.ok(Math.abs(chunked.valence - single.valence) < 1e-9);
  assert.ok(Math.abs(chunked.arousal - single.arousal) < 1e-9);
  assert.ok(Math.abs(chunked.dominance - single.dominance) < 1e-9);
});

test('resolveMoodState 为旧状态的空锚点按当前基线补默认值', () => {
  const stored = Object.assign({
    account: 900000001,
    valence: 0.55,
    arousal: 0.75,
    dominance: -0.2,
    updatedAt: 1_000,
    band: 'excited' as const,
    bandSince: 900,
    lastBandChangeAt: 800,
    mainEmotion: null,
    emotionSince: null,
    lastEmotionChangeAt: null,
    reserve: 0.8,
    reserveBand: 'full' as const,
    reserveBandSince: null,
    reserveLastChangeAt: null,
    lastReplyAt: null,
  }, {
    valenceD0: null,
    valenceU: null,
    arousalD0: null,
    arousalU: null,
    dominanceD0: null,
    dominanceU: null,
  });
  const settings = {
    baseline: { valence: 0.1, arousal: 0.4 },
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    reserve: { initial: 0.8 },
  } as Parameters<typeof resolveMoodState>[0]['settings'];
  const resolved = resolveMoodState({
    stored,
    at: stored.updatedAt,
    settings,
    energySource: 'inner',
    appraisalEvents: [],
    replyTimes: [],
  });
  const anchors = resolved as unknown as Record<string, number>;

  assert.deepEqual({
    valenceD0: anchors.valenceD0,
    valenceU: anchors.valenceU,
    arousalD0: anchors.arousalD0,
    arousalU: anchors.arousalU,
    dominanceD0: anchors.dominanceD0,
    dominanceU: anchors.dominanceU,
  }, {
    valenceD0: stored.valence - settings.baseline.valence,
    valenceU: 0,
    arousalD0: stored.arousal - settings.baseline.arousal,
    arousalU: 0,
    dominanceD0: stored.dominance,
    dominanceU: 0,
  });
});

test('resolveMoodState 从已存锚点继续推进而不是每次读取重开停留期', () => {
  const settings = {
    baseline: { valence: 0.1, arousal: 0.4 },
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    reserve: { initial: 0.8 },
  } as Parameters<typeof resolveMoodState>[0]['settings'];
  const elapsedMs = 30 * minute;
  const surfaceT50 = surfaceHalfLifeMin(0.8, settings.surfaceHalfLifeMin);
  const stored = Object.assign({
    account: 900000001,
    valence: settings.baseline.valence + holdDecay(0.7, 0.5, 3),
    arousal: settings.baseline.arousal + holdDecay(0.4, 0.25, 2),
    dominance: holdDecay(-0.2, 0.5, 2),
    updatedAt: 1_000,
    band: 'calm' as const,
    bandSince: 900,
    lastBandChangeAt: 800,
    mainEmotion: null,
    emotionSince: null,
    lastEmotionChangeAt: null,
    reserve: 0.8,
    reserveBand: 'full' as const,
    reserveBandSince: null,
    reserveLastChangeAt: null,
    lastReplyAt: null,
  }, {
    valenceD0: 0.7,
    valenceU: 0.5,
    arousalD0: 0.4,
    arousalU: 0.25,
    dominanceD0: -0.2,
    dominanceU: 0.5,
  });
  const resolved = resolveMoodState({
    stored,
    at: stored.updatedAt + elapsedMs,
    settings,
    energySource: 'inner',
    energyMultipliers: { aloneRecovery: 0, calmRecoveryCost: 0 },
    appraisalEvents: [],
    replyTimes: [],
  });
  const nextValenceU = stored.valenceU + elapsedMs / (surfaceT50 * minute);
  const nextArousalU = stored.arousalU + elapsedMs / (settings.arousalHalfLifeMin * minute);
  const nextDominanceU = stored.dominanceU + elapsedMs / (settings.arousalHalfLifeMin * minute);
  const expectedValence = settings.baseline.valence + holdDecay(stored.valenceD0, nextValenceU, 3);
  const expectedArousal = settings.baseline.arousal + holdDecay(stored.arousalD0, nextArousalU, 2);
  const expectedDominance = holdDecay(stored.dominanceD0, nextDominanceU, 2);

  assert.ok(Math.abs(resolved.valence - expectedValence) < 1e-9, `actual=${resolved.valence}, expected=${expectedValence}`);
  assert.ok(Math.abs(resolved.arousal - expectedArousal) < 1e-9, `actual=${resolved.arousal}, expected=${expectedArousal}`);
  assert.ok(Math.abs(resolved.dominance - expectedDominance) < 1e-9, `actual=${resolved.dominance}, expected=${expectedDominance}`);
  assert.equal(resolved.valenceU, nextValenceU);
  assert.equal(resolved.arousalU, nextArousalU);
  assert.equal(resolved.dominanceU, nextDominanceU);
});
