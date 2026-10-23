import assert from 'node:assert/strict';
import test from 'node:test';
import * as moodCore from '../src/core/mood/core.ts';
import {
  capSenderValenceDelta,
  capSenderReserveDelta,
  advanceMoodState,
  clampMood,
  decayValue,
  isCompanionshipActive,
  nextBand,
  bufferNegativeDelta,
  surfaceHalfLifeMin,
  applyArousalDelta,
  SENDER_VALENCE_CAP,
  type MoodBandState,
} from '../src/core/mood/core.ts';

const minute = 60 * 1000;

function bandState(overrides: Partial<MoodBandState> = {}): MoodBandState {
  return { band: 'calm', bandSince: 0, lastBandChangeAt: 0, ...overrides };
}

test('衰减数值按半衰期折半逼近基线', () => {
  assert.ok(Math.abs(decayValue(0.5, 0.1, 30 * minute, 30) - 0.3) < 1e-12);
  assert.ok(Math.abs(decayValue(0.5, 0.1, 60 * minute, 30) - 0.2) < 1e-12);
  assert.ok(Math.abs(decayValue(-0.6, 0.1, 15 * minute, 30) - (0.1 - 0.7 * 2 ** -0.5)) < 1e-12);
  assert.equal(decayValue(-0.6, 0.1, 0, 30), -0.6);
  assert.equal(decayValue(-0.6, 0.1, -5, 30), -0.6);
});

test('同一发送者的软上限按 60 分钟累计变化递减', () => {
  const now = 1_000 * minute;
  const history = [
    { time: now - 10 * minute, senderId: 42, appliedDv: 0.25 },
    { time: now - 70 * minute, senderId: 42, appliedDv: -0.2 },
    { time: now - 5 * minute, senderId: 43, appliedDv: 0.3 },
  ];

  assert.ok(Math.abs(capSenderValenceDelta(0.15, 42, history, now) - 0.103125) < 1e-12);
  assert.ok(Math.abs(capSenderValenceDelta(-0.15, 42, history, now) - (-0.103125)) < 1e-12);
  assert.equal(capSenderValenceDelta(0.15, 99, history, now), 0.15);
  assert.equal(capSenderValenceDelta(0.15, null, history, now), 0.15);
  assert.equal(SENDER_VALENCE_CAP, 0.8);
  assert.equal(capSenderReserveDelta(0.1, 42, [{ time: now - minute, senderId: 42, appliedDr: 0.15 }], now), 0.05);
  assert.deepEqual(clampMood(1.4, -0.2), { valence: 1, arousal: 0 });
  assert.deepEqual(clampMood(-0.3, 0.9), { valence: -0.3, arousal: 0.9 });
});

test('软上限让同一发送者连续六次负向事件逐步减弱但不会提前归零', () => {
  const now = 2_000 * minute;
  const history: Array<{ time: number; senderId: number | null; appliedDv: number }> = [];
  const applied = Array.from({ length: 6 }, (_, index) => {
    const time = now + index * minute;
    const value = capSenderValenceDelta(-0.12, 42, history, time);
    history.push({ time, senderId: 42, appliedDv: value });
    return value;
  });

  assert.ok(Math.abs(applied[5] ?? 0) > 0);
  assert.ok(applied.reduce((sum, value) => sum + Math.abs(value), 0) <= 0.8);
});

test('水库核心导出缓冲和半衰期函数供情绪状态计算复用', () => {
  assert.deepEqual(bufferNegativeDelta(-0.08, 1), {
    surfaceDelta: -0.03,
    absorbed: 0.05,
    reserve: 0.925,
  });
  assert.deepEqual(bufferNegativeDelta(-0.08, 0), {
    surfaceDelta: -0.08,
    absorbed: 0,
    reserve: 0,
  });
  assert.equal(surfaceHalfLifeMin(1), 40);
  assert.equal(surfaceHalfLifeMin(0), 140);
  assert.equal(applyArousalDelta(0.8, 0.3), 0.86);
  assert.equal(applyArousalDelta(0.8, -0.3), 0.5);
});

test('I/E/mixed 回能按来源和陪伴切换半衰期，难过时暂停', () => {
  const recoverReserve = Reflect.get(moodCore, 'recoverReserve') as ((input: {
    reserve: number;
    energySource: 'inner' | 'outer' | 'mixed';
    elapsedMs: number;
    company: boolean;
    sad: boolean;
  }) => number) | undefined;
  assert.equal(typeof recoverReserve, 'function');
  if (!recoverReserve) return;

  const twoHours = 2 * 60 * minute;
  const innerAlone = recoverReserve({ reserve: 0.2, energySource: 'inner', elapsedMs: twoHours, company: false, sad: false });
  const innerCompany = recoverReserve({ reserve: 0.2, energySource: 'inner', elapsedMs: twoHours, company: true, sad: false });
  const outerCompany = recoverReserve({ reserve: 0.2, energySource: 'outer', elapsedMs: twoHours, company: true, sad: false });
  const outerAlone = recoverReserve({ reserve: 0.2, energySource: 'outer', elapsedMs: twoHours, company: false, sad: false });
  const mixedAlone = recoverReserve({ reserve: 0.2, energySource: 'mixed', elapsedMs: twoHours, company: false, sad: false });
  const mixedCompany = recoverReserve({ reserve: 0.2, energySource: 'mixed', elapsedMs: twoHours, company: true, sad: false });

  assert.equal(innerAlone, 0.6);
  assert.equal(innerCompany, 0.2);
  assert.ok(outerCompany > outerAlone);
  assert.equal(mixedAlone, mixedCompany);
  assert.equal(recoverReserve({ reserve: 0.2, energySource: 'outer', elapsedMs: twoHours, company: true, sad: true }), 0.2);
});

test('动态水位控制表层恢复速度，低于难过阈值时恢复水位暂停', () => {
  const common = {
    from: 0,
    to: 60 * minute,
    baseline: { valence: 0.1, arousal: 0.4 },
    surfaceHalfLifeMin: 40,
    arousalHalfLifeMin: 40,
    energySource: 'mixed' as const,
    lastReplyAt: null,
    companionshipPositive: false,
  };
  const fullWater = advanceMoodState({ valence: -0.15, arousal: 0.4, reserve: 1 }, common);
  const lowWater = advanceMoodState({ valence: -0.15, arousal: 0.4, reserve: 0.2 }, common);
  const sad = advanceMoodState({ valence: -0.1, arousal: 0.4, reserve: 0.2 }, { ...common, to: 15 * minute });

  assert.ok(fullWater.valence > lowWater.valence);
  assert.ok(sad.valence > -0.1);
  assert.ok(sad.reserve < 0.2);
});

test('水位为零时四次负向事件后进入 annoyed', () => {
  const baseline = { valence: 0.1, arousal: 0.4 };
  const dynamics = { valence: 0.1, arousal: 0.4, reserve: 0 };
  let value = dynamics;
  let band = bandState({ band: 'calm', bandSince: -30 * minute, lastBandChangeAt: -30 * minute });

  for (let index = 1; index <= 4; index += 1) {
    const time = index * 2 * minute;
    if (index > 1) {
      value = advanceMoodState(value, {
        from: (index - 1) * 2 * minute,
        to: time,
        baseline,
        surfaceHalfLifeMin: 40,
        arousalHalfLifeMin: 40,
        energySource: 'mixed',
        lastReplyAt: null,
        companionshipPositive: false,
      });
    }
    const buffered = bufferNegativeDelta(-0.15, value.reserve);
    value = { ...value, valence: value.valence + buffered.surfaceDelta, reserve: buffered.reserve };
    const next = nextBand(band, value.valence, time, 'event');
    if (next !== band.band) band = { ...band, band: next, bandSince: time, lastBandChangeAt: time };
  }

  assert.equal(band.band, 'annoyed');
});

test('满水位起每三分钟的小事前五次保持 calm，第十一次进入 annoyed', () => {
  const baseline = { valence: 0.1, arousal: 0.4 };
  let value = { valence: 0.1, arousal: 0.4, reserve: 1 };
  let band = bandState({ band: 'calm', bandSince: -30 * minute, lastBandChangeAt: -30 * minute });
  const bands: string[] = [];

  for (let index = 1; index <= 11; index += 1) {
    const time = index * 3 * minute;
    if (index > 1) {
      value = advanceMoodState(value, {
        from: (index - 1) * 3 * minute,
        to: time,
        baseline,
        surfaceHalfLifeMin: 40,
        arousalHalfLifeMin: 40,
        energySource: 'mixed',
        lastReplyAt: null,
        companionshipPositive: false,
      });
    }
    const buffered = bufferNegativeDelta(-0.08, value.reserve);
    value = { ...value, valence: value.valence + buffered.surfaceDelta, reserve: buffered.reserve };
    const next = nextBand(band, value.valence, time, 'event');
    if (next !== band.band) band = { ...band, band: next, bandSince: time, lastBandChangeAt: time };
    bands.push(band.band);
  }

  assert.ok(bands.slice(0, 5).every((item) => item === 'calm'));
  assert.equal(bands.findIndex((item) => item === 'annoyed') + 1, 11);
});

test('同一次负向事件在高水位后一小时恢复得比低水位更高', () => {
  const baseline = { valence: 0.1, arousal: 0.4 };
  const afterHour = (reserve: number) => {
    const buffered = bufferNegativeDelta(-0.25, reserve);
    return advanceMoodState({
      valence: baseline.valence + buffered.surfaceDelta,
      arousal: baseline.arousal,
      reserve: buffered.reserve,
    }, {
      from: 0,
      to: 60 * minute,
      baseline,
      surfaceHalfLifeMin: 40,
      arousalHalfLifeMin: 40,
      energySource: 'mixed',
      lastReplyAt: null,
      companionshipPositive: false,
    });
  };

  assert.ok(afterHour(1).valence > afterHour(0.2).valence);
});

test('appraisal success is explicit provenance, not model reason text', () => {
  const isSuccessfulAppraisal = Reflect.get(moodCore, 'isSuccessfulAppraisal') as ((event: {
    source: string;
    appraisalValid: boolean | null;
    reason?: string;
  }) => boolean) | undefined;
  assert.equal(typeof isSuccessfulAppraisal, 'function');
  if (!isSuccessfulAppraisal) return;
  assert.equal(isSuccessfulAppraisal({ source: 'appraise', appraisalValid: true, reason: 'budget' }), true);
  assert.equal(isSuccessfulAppraisal({ source: 'appraise', appraisalValid: true, reason: 'appraise_error' }), true);
  assert.equal(isSuccessfulAppraisal({ source: 'appraise', appraisalValid: false, reason: 'budget' }), false);
  assert.equal(isSuccessfulAppraisal({ source: 'appraise', appraisalValid: null, reason: 'appraise_parse_error' }), false);
  assert.equal(isSuccessfulAppraisal({ source: 'rule', appraisalValid: true, reason: '评估失败' }), false);
});

test('有人陪必须有最近回复且最近评估平均不为负', () => {
  const now = 10 * minute;
  assert.equal(isCompanionshipActive(now - 15 * minute, now, 0), true);
  assert.equal(isCompanionshipActive(now - 15 * minute - 1, now, 0.1), false);
  assert.equal(isCompanionshipActive(now - minute, now, -0.01), false);
  assert.equal(isCompanionshipActive(null, now, 0.2), false);
});

test('静摩擦：越过当前档位边界 0.05 才换档', () => {
  const now = 100 * minute;
  const calm = bandState({ band: 'calm', bandSince: now - 30 * minute, lastBandChangeAt: now - 30 * minute });

  assert.equal(nextBand(calm, 0.19, now, 'event'), 'calm');
  assert.equal(nextBand(calm, 0.2, now, 'event'), 'happy');

  const happy = bandState({ band: 'happy', bandSince: now - 30 * minute, lastBandChangeAt: now - 30 * minute });
  assert.equal(nextBand(happy, 0.11, now, 'event'), 'happy');
  assert.equal(nextBand(happy, 0.09, now, 'event'), 'calm');
});

test('滑动摩擦：上次换档 5 分钟内余量降为 0.02', () => {
  const now = 100 * minute;
  const sliding = bandState({ band: 'calm', bandSince: now - 1 * minute, lastBandChangeAt: now - 1 * minute });
  assert.equal(nextBand(sliding, 0.17, now, 'event'), 'happy');

  const staticState = bandState({ band: 'calm', bandSince: now - 6 * minute, lastBandChangeAt: now - 6 * minute });
  assert.equal(nextBand(staticState, 0.17, now, 'event'), 'calm');
});

test('decay 换档受 10 分钟最短停留限制，event 不受限制', () => {
  const now = 100 * minute;
  const young = bandState({ band: 'calm', bandSince: now - 9 * minute, lastBandChangeAt: now - 30 * minute });
  assert.equal(nextBand(young, 0.4, now, 'decay'), 'calm');
  assert.equal(nextBand(young, 0.4, now, 'event'), 'happy');

  const settled = bandState({ band: 'calm', bandSince: now - 10 * minute, lastBandChangeAt: now - 30 * minute });
  assert.equal(nextBand(settled, 0.4, now, 'decay'), 'happy');
});

test('满足条件时一次可以跨多档', () => {
  const now = 100 * minute;
  const low = bandState({ band: 'low', bandSince: now - 30 * minute, lastBandChangeAt: now - 30 * minute });
  assert.equal(nextBand(low, 0.6, now, 'event'), 'excited');

  const excited = bandState({ band: 'excited', bandSince: now - 30 * minute, lastBandChangeAt: now - 30 * minute });
  assert.equal(nextBand(excited, -0.8, now, 'event'), 'low');
  assert.equal(nextBand(excited, 0.45, now, 'event'), 'excited');
});
