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
  bandOf,
  bufferNegativeDelta,
  surfaceHalfLifeMin,
  applyArousalDelta,
  applyDominanceDelta,
  SENDER_VALENCE_CAP,
} from '../src/core/mood/core.ts';

const minute = 60 * 1000;

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
  const reserveHistory = [{ time: now - minute, senderId: 42, appliedDr: 0.15 }];
  assert.equal(capSenderReserveDelta(0.1, 42, reserveHistory, now, { senderHourlyCap: 0 }), 0);
  assert.ok(capSenderReserveDelta(0.1, 42, reserveHistory, now, { senderHourlyCap: 3 }) > 0.05);
  assert.deepEqual(clampMood(1.4, -0.2), { valence: 1, arousal: 0, dominance: 0 });
  assert.deepEqual(clampMood(-0.3, 0.9, -1.4), { valence: -0.3, arousal: 0.9, dominance: -1 });
  assert.equal(applyDominanceDelta(0.9, 0.3), 1);
  assert.equal(applyDominanceDelta(-0.9, -0.3), -1);
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
  assert.equal(bufferNegativeDelta(-0.08, 1, { bufferCost: 0 }).reserve, 1);
  const expensiveBuffer = bufferNegativeDelta(-0.08, 1, { bufferCost: 3 });
  assert.ok(expensiveBuffer.reserve < 0.925 && expensiveBuffer.reserve >= 0);
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
    energyMultipliers?: { aloneRecovery?: number; companyRecovery?: number };
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
  assert.equal(recoverReserve({ reserve: 0.2, energySource: 'inner', elapsedMs: twoHours, company: false, sad: false, energyMultipliers: { aloneRecovery: 0 } }), 0.2);
  assert.ok(recoverReserve({ reserve: 0.2, energySource: 'inner', elapsedMs: twoHours, company: false, sad: false, energyMultipliers: { aloneRecovery: 3 } }) > innerAlone);
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
  const fullWater = advanceMoodState({ valence: -0.15, arousal: 0.4, dominance: 0, reserve: 1 }, common);
  const lowWater = advanceMoodState({ valence: -0.15, arousal: 0.4, dominance: 0, reserve: 0.2 }, common);
  const dominant = advanceMoodState({ valence: 0.1, arousal: 0.4, dominance: 0.8, reserve: 0.5 }, common);
  const sad = advanceMoodState({ valence: -0.1, arousal: 0.4, dominance: 0, reserve: 0.2 }, { ...common, to: 15 * minute });
  const noCalmCost = advanceMoodState({ valence: -0.1, arousal: 0.4, dominance: 0, reserve: 0.2 }, {
    ...common,
    to: 15 * minute,
    energyMultipliers: { calmRecoveryCost: 0 },
  });
  const highCalmCost = advanceMoodState({ valence: -0.1, arousal: 0.4, dominance: 0, reserve: 0.2 }, {
    ...common,
    to: 15 * minute,
    energyMultipliers: { calmRecoveryCost: 3 },
  });

  assert.ok(fullWater.valence > lowWater.valence);
  assert.ok(dominant.dominance > 0 && dominant.dominance < 0.8);
  assert.ok(sad.valence > -0.1);
  assert.ok(sad.reserve < 0.2);
  assert.ok(noCalmCost.reserve > sad.reserve);
  assert.ok(highCalmCost.reserve < sad.reserve && highCalmCost.reserve >= 0);
});

test('水位为零时连续负向事件进入压抑区域', () => {
  const baseline = { valence: 0.1, arousal: 0.4 };
  const dynamics = { valence: 0.1, arousal: 0.4, dominance: 0, reserve: 0 };
  let value = dynamics;

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
  }

  assert.equal(bandOf(value.valence, value.arousal), 'oppressed');
});

test('满水位会延后负向事件进入压抑区域', () => {
  const baseline = { valence: 0.1, arousal: 0.4 };
  const firstSuppressedIndex = (initialReserve: number) => {
    let value = { valence: baseline.valence, arousal: baseline.arousal, dominance: 0, reserve: initialReserve };
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
      if (bandOf(value.valence, value.arousal) === 'oppressed') return index;
    }
    return Infinity;
  };

  assert.ok(firstSuppressedIndex(1) > firstSuppressedIndex(0));
});

test('同一次负向事件在高水位后一小时恢复得比低水位更高', () => {
  const baseline = { valence: 0.1, arousal: 0.4 };
  const afterHour = (reserve: number) => {
    const buffered = bufferNegativeDelta(-0.25, reserve);
    return advanceMoodState({
      valence: baseline.valence + buffered.surfaceDelta,
      arousal: baseline.arousal,
      dominance: 0,
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

test('负向区域在唤醒度 0.55 处分为不愉快和压抑', () => {
  assert.equal(bandOf(-0.15, 0.55), 'unpleasant');
  assert.equal(bandOf(-0.15, 0.54), 'oppressed');
});

test('正向区域在唤醒度 0.5 处分为平静与高唤醒', () => {
  assert.equal(bandOf(0, 0.49), 'calm');
  assert.equal(bandOf(0, 0.5), 'aroused');
});

test('高唤醒正向区域在愉悦度 0.3 处分为唤醒与兴奋', () => {
  assert.equal(bandOf(0.299, 0.5), 'aroused');
  assert.equal(bandOf(0.3, 0.5), 'excited');
});

test('区域由当前 PAD 坐标决定，不受旧换档停留状态影响', () => {
  assert.equal(bandOf(0.6, 0.8), 'excited');
  assert.equal(bandOf(-0.8, 0.2), 'oppressed');
  assert.equal(bandOf(-0.8, 0.8), 'unpleasant');
});

test('PAD 情绪按五区域、默认库和逐边滞回解析', () => {
  const library = Reflect.get(moodCore, 'DEFAULT_EMOTION_LIBRARY') as Array<{
    name: string; valence: number; arousal: number; dominance: number;
  }> | undefined;
  const regionOf = Reflect.get(moodCore, 'moodRegionOf') as ((valence: number, arousal: number) => string) | undefined;
  const intensity = Reflect.get(moodCore, 'emotionIntensity') as ((state: {
    valence: number; arousal: number; dominance: number;
  }, emotion: { valence: number; arousal: number; dominance: number }) => number) | undefined;
  const edgeOf = Reflect.get(moodCore, 'defaultEmotionEdge') as ((from: {
    name: string; valence: number; arousal: number; dominance: number;
  }, to: { name: string; valence: number; arousal: number; dominance: number }) => {
    margin: number; dwell: number; jump: boolean;
  }) | undefined;
  const resolve = Reflect.get(moodCore, 'resolveMoodEmotions') as ((input: {
    valence: number; arousal: number; dominance: number;
    emotions: typeof library;
    edgeOverrides: Record<string, Record<string, { margin?: number; dwell?: number; jump?: boolean }>>;
    currentEmotion: string | null; emotionSince: number | null; lastEmotionChangeAt: number | null;
    now: number; messageId: string; subMax: number; subTh: number;
  }) => { region: string; mainEmotion: string; subEmotions: string[] }) | undefined;
  const dwellScale = Reflect.get(moodCore, 'dwellMultiplierForMessageId') as ((messageId: string) => number) | undefined;

  assert.equal(typeof library, 'object');
  assert.equal(typeof regionOf, 'function');
  assert.equal(typeof intensity, 'function');
  assert.equal(typeof edgeOf, 'function');
  assert.equal(typeof resolve, 'function');
  assert.equal(typeof dwellScale, 'function');
  if (!library || !regionOf || !intensity || !edgeOf || !resolve || !dwellScale) return;

  assert.equal(library.length, 16);
  assert.equal(regionOf(-0.15, 0.55), 'unpleasant');
  assert.equal(regionOf(-0.15, 0.54), 'oppressed');
  assert.equal(regionOf(-0.149, 0.5), 'aroused');
  assert.equal(regionOf(0.3, 0.5), 'excited');
  assert.equal(regionOf(0.29, 0.49), 'calm');

  const excited = library.find((emotion) => emotion.name === '兴奋')!;
  const calm = library.find((emotion) => emotion.name === '平静')!;
  const shy = library.find((emotion) => emotion.name === '害羞')!;
  const angry = library.find((emotion) => emotion.name === '生气')!;
  assert.equal(intensity(excited, excited), 1);
  assert.equal(edgeOf(calm, excited).dwell, 10);
  assert.equal(edgeOf(shy, angry).jump, false);
  assert.equal(edgeOf(angry, shy).jump, false);
  assert.equal(dwellScale('mood-5'), dwellScale('mood-5'));
  assert.ok(dwellScale('mood-5') >= 0.8 && dwellScale('mood-5') <= 1.4);

  const selected = resolve({
    valence: excited.valence,
    arousal: excited.arousal,
    dominance: excited.dominance,
    emotions: library,
    edgeOverrides: {},
    currentEmotion: '平静',
    emotionSince: 0,
    lastEmotionChangeAt: 0,
    now: 60 * minute,
    messageId: 'mood-5',
    subMax: 2,
    subTh: 0.5,
  });
  assert.equal(selected.region, 'excited');
  assert.equal(selected.mainEmotion, '兴奋');
  assert.ok(selected.subEmotions.length <= 2);

  const blocked = resolve({
    valence: angry.valence,
    arousal: angry.arousal,
    dominance: angry.dominance,
    emotions: library,
    edgeOverrides: {},
    currentEmotion: '害羞',
    emotionSince: 0,
    lastEmotionChangeAt: 0,
    now: 60 * minute,
    messageId: 'mood-6',
    subMax: 2,
    subTh: 0.5,
  });
  assert.equal(blocked.mainEmotion, '害羞');

  const source = { name: '来源', valence: 0, arousal: 0.3, dominance: 0 };
  const target = { name: '目标', valence: 0.2, arousal: 0.5, dominance: 0 };
  const resolveEdge = (
    edge: { margin?: number; dwell?: number; jump?: boolean },
    now: number,
  ) => resolve({
    valence: 0.12,
    arousal: 0.4,
    dominance: 0,
    emotions: [source, target],
    edgeOverrides: { 来源: { 目标: edge } },
    currentEmotion: '来源',
    emotionSince: 0,
    lastEmotionChangeAt: 0,
    now,
    messageId: 'per-edge-dwell',
    subMax: 0,
    subTh: 0.5,
  });
  const marginNotScaled = resolveEdge({ margin: 0.02, dwell: 0, jump: true }, 1_000);
  const marginBlocks = resolveEdge({ margin: 0.03, dwell: 0, jump: true }, 1_000);
  assert.equal(marginNotScaled.mainEmotion, '目标');
  assert.equal(marginBlocks.mainEmotion, '来源');

  const dwellMs = 10 * dwellScale('per-edge-dwell') * minute;
  assert.equal(resolveEdge({ margin: 0, dwell: 10, jump: true }, dwellMs - 1).mainEmotion, '来源');
  assert.equal(resolveEdge({ margin: 0, dwell: 10, jump: true }, dwellMs).mainEmotion, '目标');
  assert.equal(resolveEdge({ margin: 0, dwell: 0, jump: false }, dwellMs).mainEmotion, '来源');
});
