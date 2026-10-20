import assert from 'node:assert/strict';
import test from 'node:test';
import { buildActivityResponse, buildActivitySuggestion } from '../src/core/profiles/presence.ts';
import type { MessageStorageRecord } from '../src/store/repository.ts';

const sessionId = '7:group:9';

function dateKey(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function message(
  time: number,
  plainText: string,
  segments: unknown[] = [{ type: 'text', text: plainText }],
  senderId = 42,
): MessageStorageRecord {
  return {
    sessionId,
    messageId: `m-${time}-${senderId}`,
    senderId,
    senderName: '好友',
    isSelf: false,
    plainText,
    segments,
    time,
  };
}

test('hour/week 按本地时间返回占比且只统计近 90 个本地日', () => {
  const now = new Date(2026, 4, 15, 12, 30).getTime();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 89);
  const outside = start.getTime() - 1;
  const late = new Date(start);
  late.setHours(23, 15, 0, 0);
  const records = [
    message(outside, '越界'),
    message(start.getTime(), '开始', [{ type: 'image', url: 'fixture' }]),
    message(late.getTime(), '深夜'),
    message(now, '今天'),
    message(now, '其他成员', undefined, 43),
    { ...message(now, '机器人'), isSelf: true },
  ];

  const hour = buildActivityResponse(records, now, 'hour');
  const week = buildActivityResponse(records, now, 'week');
  assert.equal(hour.buckets.length, 24);
  assert.equal(week.buckets.length, 7);
  assert.ok(Math.abs(hour.buckets.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.ok(Math.abs(week.buckets.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.equal(hour.buckets[0], 1 / 4);
  assert.equal(hour.buckets[12], 2 / 4);
  assert.equal(hour.buckets[23], 1 / 4);
  assert.equal(hour.summary.total, 4);
  assert.equal(hour.summary.avgChars, 2.5);
  assert.equal(hour.summary.imageRatio, 1 / 4);
  assert.equal(buildActivityResponse(records, now, 'hour', 42).summary.total, 3);
  assert.equal(buildActivityResponse(records, now, 'hour', 43).summary.total, 1);
});

test('month/year 提供固定长度的本地日历日计数，包含起始日边界', () => {
  const now = new Date(2026, 4, 15, 12, 0).getTime();
  const monthStart = new Date(now);
  monthStart.setHours(0, 0, 0, 0);
  monthStart.setDate(monthStart.getDate() - 29);
  const beforeMonth = monthStart.getTime() - 1;
  const records = [
    message(beforeMonth, '不计入'),
    message(monthStart.getTime(), '起始日'),
    message(now, '今天'),
  ];

  const month = buildActivityResponse(records, now, 'month');
  const year = buildActivityResponse(records, now, 'year');
  assert.equal(month.buckets.length, 30);
  assert.equal(year.buckets.length, 365);
  assert.deepEqual(month.buckets[0], { date: dateKey(monthStart), count: 1 });
  assert.equal(month.buckets.reduce((sum, bucket) => sum + bucket.count, 0), 2);
  assert.equal(year.buckets.reduce((sum, bucket) => sum + bucket.count, 0), 3);
});

test('群活动建议允许三小时窗口跨越午夜', () => {
  const buckets = Array<number>(24).fill(0.4 / 21);
  buckets[23] = 0.2;
  buckets[0] = 0.2;
  buckets[1] = 0.2;

  const suggestion = buildActivitySuggestion(buckets);
  assert.equal(suggestion?.from, '23:00');
  assert.equal(suggestion?.to, '02:00');
  assert.equal(suggestion?.windowKey, '23:00-02:00');
});
