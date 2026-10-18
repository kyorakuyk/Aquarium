import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capSenderValenceDelta,
  clampMood,
  decayValue,
  nextBand,
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

test('同一发送者 60 分钟内累计 |Δvalence| 不超过 0.3，超出部分截掉', () => {
  const now = 1_000 * minute;
  const history = [
    { time: now - 10 * minute, senderId: 42, appliedDv: 0.25 },
    { time: now - 70 * minute, senderId: 42, appliedDv: -0.2 },
    { time: now - 5 * minute, senderId: 43, appliedDv: 0.3 },
  ];

  assert.ok(Math.abs(capSenderValenceDelta(0.15, 42, history, now) - 0.05) < 1e-12);
  assert.ok(Math.abs(capSenderValenceDelta(-0.15, 42, history, now) - (-0.05)) < 1e-12);
  assert.equal(capSenderValenceDelta(0.15, 99, history, now), 0.15);
  assert.equal(capSenderValenceDelta(0.15, null, history, now), 0.15);
  assert.equal(SENDER_VALENCE_CAP, 0.3);
  assert.deepEqual(clampMood(1.4, -0.2), { valence: 1, arousal: 0 });
  assert.deepEqual(clampMood(-0.3, 0.9), { valence: -0.3, arousal: 0.9 });
});

test('静摩擦：越过当前档位边界 0.08 才换档', () => {
  const now = 100 * minute;
  const calm = bandState({ band: 'calm', bandSince: now - 30 * minute, lastBandChangeAt: now - 30 * minute });

  assert.equal(nextBand(calm, 0.22, now, 'event'), 'calm');
  assert.equal(nextBand(calm, 0.23, now, 'event'), 'happy');

  const happy = bandState({ band: 'happy', bandSince: now - 30 * minute, lastBandChangeAt: now - 30 * minute });
  assert.equal(nextBand(happy, 0.08, now, 'event'), 'happy');
  assert.equal(nextBand(happy, 0.06, now, 'event'), 'calm');
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
