import type { MessageStorageRecord } from '../../store/repository.ts';

export type ActivityView = 'hour' | 'week' | 'month' | 'year';

export interface ActivitySummary {
  total: number;
  avgChars: number;
  imageRatio: number;
}

export interface ActivityDayBucket {
  date: string;
  count: number;
}

export interface ActivityDistributionResponse {
  view: 'hour' | 'week';
  buckets: number[];
  summary: ActivitySummary;
}

export interface ActivityCalendarResponse {
  view: 'month' | 'year';
  buckets: ActivityDayBucket[];
  summary: ActivitySummary;
}

export interface ActivitySuggestion {
  from: string;
  to: string;
  windowKey: string;
  ratio: number;
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function buildActivitySuggestion(
  buckets: readonly number[],
  minimumRatio = 0.35,
): ActivitySuggestion | null {
  if (buckets.length !== 24 || buckets.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('活动时段分布无效');
  }
  if (!Number.isFinite(minimumRatio) || minimumRatio < 0 || minimumRatio > 1) {
    throw new RangeError('活动建议阈值无效');
  }

  let startHour = 0;
  let ratio = 0;
  for (let start = 0; start < 24; start += 1) {
    const candidate = buckets[start]! + buckets[(start + 1) % 24]! + buckets[(start + 2) % 24]!;
    if (candidate > ratio) {
      startHour = start;
      ratio = candidate;
    }
  }
  if (ratio < minimumRatio) return null;

  const from = hourLabel(startHour);
  const to = hourLabel((startHour + 3) % 24);
  return { from, to, windowKey: `${from}-${to}`, ratio };
}

export function localDateKey(value: Date | number): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function localStartOfDays(now: number, dayCount: number): number {
  if (!Number.isFinite(now) || !Number.isSafeInteger(dayCount) || dayCount <= 0) {
    throw new RangeError('活动统计范围无效');
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - dayCount + 1);
  return start.getTime();
}

function eligibleMessages(
  messages: readonly MessageStorageRecord[],
  from: number,
  now: number,
  userId?: number,
): MessageStorageRecord[] {
  return messages.filter((message) => !message.isSelf
    && message.time >= from && message.time <= now
    && (userId === undefined || message.senderId === userId));
}

function summaryFor(messages: readonly MessageStorageRecord[]): ActivitySummary {
  const total = messages.length;
  const chars = messages.reduce((sum, message) => sum + Array.from(message.plainText).length, 0);
  const withImage = messages.filter((message) => message.segments.some((segment) => {
    if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) return false;
    return (segment as Record<string, unknown>).type === 'image';
  })).length;
  return {
    total,
    avgChars: total === 0 ? 0 : chars / total,
    imageRatio: total === 0 ? 0 : withImage / total,
  };
}

function distribution(counts: number[], total: number): number[] {
  return total === 0 ? counts.map(() => 0) : counts.map((count) => count / total);
}

function localDays(now: number, count: number): Array<{ date: Date; key: string }> {
  const date = new Date(localStartOfDays(now, count));
  return Array.from({ length: count }, () => {
    const day = new Date(date);
    date.setDate(date.getDate() + 1);
    return { date: day, key: localDateKey(day) };
  });
}

export function buildActivityResponse(
  messages: readonly MessageStorageRecord[],
  now: number,
  view: 'hour' | 'week',
  userId?: number,
): ActivityDistributionResponse;
export function buildActivityResponse(
  messages: readonly MessageStorageRecord[],
  now: number,
  view: 'month' | 'year',
  userId?: number,
): ActivityCalendarResponse;
export function buildActivityResponse(
  messages: readonly MessageStorageRecord[],
  now: number,
  view: ActivityView,
  userId?: number,
): ActivityDistributionResponse | ActivityCalendarResponse;
export function buildActivityResponse(
  messages: readonly MessageStorageRecord[],
  now: number,
  view: ActivityView,
  userId?: number,
): ActivityDistributionResponse | ActivityCalendarResponse {
  if (!Number.isFinite(now)) throw new RangeError('统计时点必须是有限数字');
  const summaryMessages = eligibleMessages(messages, localStartOfDays(now, 90), now, userId);
  const summary = summaryFor(summaryMessages);
  if (view === 'hour' || view === 'week') {
    const counts = Array(view === 'hour' ? 24 : 7).fill(0) as number[];
    for (const message of summaryMessages) {
      const date = new Date(message.time);
      const index = view === 'hour' ? date.getHours() : (date.getDay() + 6) % 7;
      counts[index] = (counts[index] ?? 0) + 1;
    }
    return { view, buckets: distribution(counts, summaryMessages.length), summary };
  }

  const dayCount = view === 'month' ? 30 : 365;
  const days = localDays(now, dayCount);
  const counts = new Map(days.map(({ key }) => [key, 0]));
  for (const message of eligibleMessages(messages, days[0]!.date.getTime(), now, userId)) {
    const key = localDateKey(message.time);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    view,
    buckets: days.map(({ key }) => ({ date: key, count: counts.get(key) ?? 0 })),
    summary,
  };
}
