import assert from 'node:assert/strict';
import test from 'node:test';
import { sleepEnergy, sleepPlan } from '../src/core/sleep/index.ts';

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month, day, hour, minute).getTime();
}

test('sleepPlan 支持跨午夜并按入睡日期生成 cycleKey', () => {
  const asleep = sleepPlan(at(2026, 9, 18, 1), '22:00', '07:00');
  assert.deepEqual(asleep, {
    asleep: true,
    cycleKey: '2026-10-17',
    wakeAt: at(2026, 9, 18, 7),
    bedAt: at(2026, 9, 17, 22),
  });

  const awake = sleepPlan(at(2026, 9, 18, 12), '22:00', '07:00');
  assert.deepEqual(awake, {
    asleep: false,
    cycleKey: '2026-10-18',
    wakeAt: at(2026, 9, 18, 7),
    bedAt: at(2026, 9, 18, 22),
  });
});

test('sleepPlan 在入睡边界转为睡着，在醒来边界转为醒着', () => {
  const atBedtime = sleepPlan(at(2026, 9, 18, 2), '02:00', '09:00');
  assert.equal(atBedtime.asleep, true);
  assert.equal(atBedtime.bedAt, at(2026, 9, 18, 2));

  const atWake = sleepPlan(at(2026, 9, 18, 9), '02:00', '09:00');
  assert.equal(atWake.asleep, false);
  assert.equal(atWake.wakeAt, at(2026, 9, 18, 9));
  assert.equal(atWake.bedAt, at(2026, 9, 19, 2));
});

test('sleepPlan 对相同或非法时间一律视为醒着', () => {
  for (const [bedtime, wake] of [['09:00', '09:00'], ['25:00', '07:00'], ['bad', '07:00']]) {
    const plan = sleepPlan(at(2026, 9, 18, 12), bedtime, wake);
    assert.equal(plan.asleep, false);
    assert.equal(plan.wakeAt, null);
    assert.equal(plan.bedAt, null);
  }
});

test('sleepEnergy 随清醒时长和过去一小时回复数下降并限制范围', () => {
  const wakeAt = at(2026, 9, 18, 7);
  const bedAt = at(2026, 9, 18, 22);
  const early = sleepEnergy(at(2026, 9, 18, 7), wakeAt, bedAt, 0, true);
  const later = sleepEnergy(at(2026, 9, 18, 13), wakeAt, bedAt, 0, true);
  const busier = sleepEnergy(at(2026, 9, 18, 13), wakeAt, bedAt, 5, true);
  assert.equal(early, 1);
  assert.ok(Math.abs(later - (1 - 0.8 * (6 / 15) ** 2)) < 1e-12);
  assert.ok(Math.abs(busier - (1 - 0.8 * (6 / 15) ** 2 - 0.05)) < 1e-12);
  assert.ok(later < early);
  assert.ok(busier < later);
  assert.equal(sleepEnergy(at(2026, 9, 18, 22), wakeAt, bedAt, 100, true), 0);
});

test('sleepEnergy 在 06:00 起床、02:00 入睡的当天 21:00 仍高于 0.5', () => {
  const wakeAt = at(2026, 9, 18, 6);
  const bedAt = at(2026, 9, 19, 2);
  const energy = sleepEnergy(at(2026, 9, 18, 21), wakeAt, bedAt, 0, true);

  assert.ok(energy > 0.5);
  assert.ok(Math.abs(energy - (1 - 0.8 * (15 / 20) ** 2)) < 1e-12);
});

test('sleepEnergy 在入睡前一分钟约为 0.2', () => {
  const wakeAt = at(2026, 9, 18, 6);
  const bedAt = at(2026, 9, 19, 2);
  const energy = sleepEnergy(at(2026, 9, 19, 1, 59), wakeAt, bedAt, 0, true);

  assert.ok(Math.abs(energy - 0.2) < 0.01);
});

test('sleepEnergy 将早于醒来时间的 ratio 限制到零', () => {
  const wakeAt = at(2026, 9, 18, 6);
  const bedAt = at(2026, 9, 19, 2);
  const energy = sleepEnergy(at(2026, 9, 18, 5), wakeAt, bedAt, 0, true);

  assert.ok(Number.isFinite(energy));
  assert.ok(energy <= 1);
  assert.equal(energy, 1);
});

test('sleepEnergy 在作息未启用时恒为 1', () => {
  assert.equal(sleepEnergy(at(2026, 9, 18, 23), at(2026, 9, 18, 7), at(2026, 9, 18, 22), 200, false), 1);
});
