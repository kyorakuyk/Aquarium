import assert from 'node:assert/strict';
import test from 'node:test';
import { modeScheduleSummary, modeScheduleTimeline } from '../panel/src/session-mode.ts';

const schedule = [
  { from: '01:00', to: '03:00', mode: 'busy' as const },
  { from: '23:00', to: '06:00', mode: 'mention_only' as const },
  { from: '', to: '17:00', mode: 'active' as const },
];

test('schedule summary and 24-hour timeline preserve priority and cross-midnight behavior', () => {
  assert.equal(modeScheduleSummary(schedule, 'natural'), '01:00–03:00 忙碌 · 03:00–06:00 只在被叫时 · 23:00–01:00 只在被叫时 · 其余时间自然');
  assert.deepEqual(modeScheduleTimeline(schedule, 'natural'), [
    { startMinute: 0, endMinute: 60, mode: 'mention_only' },
    { startMinute: 60, endMinute: 180, mode: 'busy' },
    { startMinute: 180, endMinute: 360, mode: 'mention_only' },
    { startMinute: 360, endMinute: 1380, mode: 'natural' },
    { startMinute: 1380, endMinute: 1440, mode: 'mention_only' },
  ]);
  assert.equal(modeScheduleSummary([], 'active'), '未设置');
});

test('schedule summary merges adjacent equal modes and calls out periods matching the default', () => {
  assert.equal(modeScheduleSummary([
    { from: '10:00', to: '12:00', mode: 'active' },
    { from: '12:00', to: '14:00', mode: 'active' },
  ], 'mention_only'), '10:00–14:00 积极 · 其余时间只在被叫时');
  assert.equal(modeScheduleSummary([
    { from: '23:00', to: '06:00', mode: 'mention_only' },
  ], 'mention_only'), '这个时段没有效果（与默认模式相同）');
});
