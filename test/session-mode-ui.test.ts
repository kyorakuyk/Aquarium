import assert from 'node:assert/strict';
import test from 'node:test';
import { modeScheduleSummary, modeScheduleTimeline } from '../panel/src/session-mode.ts';

const schedule = [
  { from: '01:00', to: '03:00', mode: 'busy' as const },
  { from: '23:00', to: '06:00', mode: 'mention_only' as const },
  { from: '', to: '17:00', mode: 'active' as const },
];

test('schedule summary and 24-hour timeline preserve priority and cross-midnight behavior', () => {
  assert.equal(modeScheduleSummary(schedule, 'natural'), '01:00–03:00 忙碌 · 23:00–06:00 只在被叫时 · 其余时间自然');
  assert.deepEqual(modeScheduleTimeline(schedule, 'natural'), [
    { startMinute: 0, endMinute: 60, mode: 'mention_only' },
    { startMinute: 60, endMinute: 180, mode: 'busy' },
    { startMinute: 180, endMinute: 360, mode: 'mention_only' },
    { startMinute: 360, endMinute: 1380, mode: 'natural' },
    { startMinute: 1380, endMinute: 1440, mode: 'mention_only' },
  ]);
  assert.equal(modeScheduleSummary([], 'active'), '未设置');
});
