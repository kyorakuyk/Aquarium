import assert from 'node:assert/strict';
import test from 'node:test';
import {
  affinityLevelOf,
  appraiseAffinityDelta,
  applyDailyAffinityCap,
  canCountCalledAffinity,
  decayAffinity,
  nextAffinityLevel,
  type AffinityHistoryEntry,
} from '../src/core/affinity/core.ts';

const day = 24 * 60 * 60 * 1000;
const today = new Date(2026, 9, 18, 12).getTime();

function event(time: number, source: AffinityHistoryEntry['source'], applied: number): AffinityHistoryEntry {
  return { time, source, applied };
}

test('情绪评估的 appliedDv 按 20 倍换算好感且单次最多 3 点', () => {
  assert.equal(appraiseAffinityDelta(0.1), 2);
  assert.equal(appraiseAffinityDelta(-0.2), -3);
  assert.equal(appraiseAffinityDelta(0), 0);
});

test('每日自动好感正向最多加 5、负向最多减 8，手动与前日事件不占限额', () => {
  const history = [
    event(today - 1_000, 'appraise', 4.5),
    event(today - 2_000, 'called', -7),
    event(today - 3_000, 'manual', 100),
    event(today - day, 'appraise', 5),
  ];
  assert.equal(applyDailyAffinityCap(2, history, today), 0.5);
  assert.equal(applyDailyAffinityCap(-3, history, today), -1);
});

test('被叫事件每天最多计 3 次并在本地日期切换后重置', () => {
  const history = [
    event(today - 10_000, 'called', 0.5),
    event(today - 9_000, 'called', 0.5),
    event(today - 8_000, 'called', 0),
    event(today - 7_000, 'appraise', 1),
    event(today - day, 'called', 0.5),
  ];
  assert.equal(canCountCalledAffinity(history, today), false);
  assert.equal(canCountCalledAffinity(history, new Date(2026, 9, 19, 0, 1).getTime()), true);
});

test('好感度在互动 3 天后按完整天数向起点 15 回落且不越过基线', () => {
  const lastInteractionAt = new Date(2026, 9, 10, 12).getTime();
  assert.equal(decayAffinity(80, lastInteractionAt, lastInteractionAt + 3 * day, 15), 80);
  assert.equal(decayAffinity(80, lastInteractionAt, lastInteractionAt + 5 * day, 15), 78);
  assert.equal(decayAffinity(-20, lastInteractionAt, lastInteractionAt + 8 * day, 15), -15);
  assert.equal(decayAffinity(-20, lastInteractionAt, lastInteractionAt + 60 * day, 15), 15);
});

test('好感十档采用自定义分界并复用防抖余量', () => {
  const tiers = { positive: [15, 35, 60, 85], negative: [-85, -60, -35, -15] };
  const samples = [-100, -85, -60, -35, -15, -14, 0, 14, 15, 35, 60, 85, 100];
  assert.deepEqual(samples.map((value) => affinityLevelOf(value, tiers)), [
    'enemy', 'loathe', 'dislike', 'uncomfortable', 'distant', 'distant', 'unfamiliar',
    'unfamiliar', 'acquaintance', 'ordinary_friend', 'more_than_friends', 'lover', 'lover',
  ]);
  const settledPositive = { current: 7, since: 0, lastChangeAt: 0 };
  assert.equal(nextAffinityLevel(settledPositive, 62, day + 1, 'event', tiers), 'ordinary_friend');
  assert.equal(nextAffinityLevel(settledPositive, 63, day + 1, 'event', tiers), 'more_than_friends');
  const settledNegative = { current: 2, since: 0, lastChangeAt: 0 };
  assert.equal(nextAffinityLevel(settledNegative, -33, day + 1, 'event', tiers), 'dislike');
  assert.equal(nextAffinityLevel(settledNegative, -32, day + 1, 'event', tiers), 'uncomfortable');
});
