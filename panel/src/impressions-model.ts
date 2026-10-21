import type { AffinityLevel, QqMemberProfileView } from './api.ts';

export interface ActivityDay {
  date: string;
  count: number;
}

export interface ActivityCalendarCell extends ActivityDay {
  week: number;
  weekday: number;
}

export interface MemberIdentityTag {
  text: string;
  category: string;
  origin: string;
  status: string;
  samples: number;
}

export interface MemberPreviewTag {
  id: number;
  text: string;
  category: string;
  subject?: string | null;
  origin: string;
  locked: boolean;
  status: string;
  activation: number;
  samples: number;
  lastSeen: number;
}

export type ImpressionsMemberSort = 'recent' | 'messages' | 'affinity';

export interface SearchableImpressionsMember {
  userId: number;
  name: string;
  messageCount: number;
  lastMessageTime: number | null;
  affinity: { value: number };
  qqProfile: { card?: string } | null;
  tags: ReadonlyArray<{ text: string; subject?: string | null }>;
}

export interface ActivityPeakWindow {
  from: number;
  to: number;
  ratio: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export function activityLevel(value: number, maximum: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value) || !Number.isFinite(maximum) || value <= 0 || maximum <= 0) return 0;
  const ratio = Math.min(value / maximum, 1);
  if (ratio < 0.2) return 0;
  if (ratio < 0.4) return 1;
  if (ratio < 0.6) return 2;
  if (ratio < 0.8) return 3;
  return 4;
}

export function memberPreviewTags(tags: readonly MemberPreviewTag[], limit = 3): MemberPreviewTag[] {
  const order = ['dislike', 'personality', 'fandom', 'identity', 'recent', 'schedule', 'speech', 'catchphrase', 'social'];
  return tags.filter((tag) => tag.status === 'confirmed'
      && !tag.locked
      && tag.activation >= 0.25
      && tag.category !== 'misc'
      && tag.category !== 'atmosphere'
      && !(tag.category === 'identity' && tag.origin === 'inferred'))
    .sort((left, right) => order.indexOf(left.category) - order.indexOf(right.category)
      || right.samples - left.samples
      || right.lastSeen - left.lastSeen
      || left.id - right.id)
    .slice(0, Math.max(0, limit));
}

export function memberRowPresentation(
  highlights: readonly string[],
  messageCount: number,
  affinityLevel: AffinityLevel,
): { subtitle: string; showAffinity: boolean } {
  const hasHighlights = highlights.length > 0;
  return {
    subtitle: hasHighlights ? highlights.join(' · ') : `${messageCount.toLocaleString('zh-CN')} 条发言`,
    showAffinity: hasHighlights || affinityLevel !== 'neutral',
  };
}

export function memberSexAgeLabel(sex: QqMemberProfileView['sex'], age: number | undefined): string {
  const sexLabel = sex === 'male' ? '男' : sex === 'female' ? '女' : undefined;
  const ageLabel = Number.isSafeInteger(age) && (age ?? 0) > 0 ? `${age} 岁` : undefined;
  if (!sexLabel && !ageLabel) return '未公开';
  return `${sexLabel ?? '未公开'} · ${ageLabel ?? '未公开'}`;
}

export function searchAndSortMembers<T extends SearchableImpressionsMember>(
  members: readonly T[],
  query: string,
  sort: ImpressionsMemberSort,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return members.filter((member) => needle.length === 0
    || member.name.toLocaleLowerCase().includes(needle)
    || (member.qqProfile?.card ?? '').toLocaleLowerCase().includes(needle)
    || member.tags.some((tag) => `${tag.subject ?? ''} ${tag.text}`.toLocaleLowerCase().includes(needle)))
    .slice()
    .sort((left, right) => {
      const score = sort === 'recent'
        ? (right.lastMessageTime ?? 0) - (left.lastMessageTime ?? 0)
        : sort === 'messages'
          ? right.messageCount - left.messageCount
          : right.affinity.value - left.affinity.value;
      return score || left.name.localeCompare(right.name, 'zh-CN') || left.userId - right.userId;
    });
}

export function peakActivityWindow(buckets: readonly number[], hours = 3): ActivityPeakWindow | undefined {
  if (buckets.length !== 24 || !Number.isSafeInteger(hours) || hours < 1 || hours > 24
    || buckets.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  let peak: ActivityPeakWindow | undefined;
  for (let from = 0; from < 24; from += 1) {
    const ratio = Array.from({ length: hours }, (_, offset) => buckets[(from + offset) % 24] ?? 0)
      .reduce((sum, value) => sum + value, 0);
    if (!peak || ratio > peak.ratio) peak = { from, to: (from + hours) % 24, ratio };
  }
  return peak?.ratio ? peak : undefined;
}

function parseLocalDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : undefined;
}

export function activityCalendarCells(days: readonly ActivityDay[]): ActivityCalendarCell[] {
  const first = days[0] ? parseLocalDate(days[0].date) : undefined;
  if (!first) return [];
  const leadingDays = (first.getDay() + 6) % 7;
  const firstOrdinal = Date.UTC(first.getFullYear(), first.getMonth(), first.getDate()) / DAY_MS;
  return days.flatMap((day) => {
    const date = parseLocalDate(day.date);
    if (!date) return [];
    const ordinal = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
    const position = leadingDays + ordinal - firstOrdinal;
    return [{
      ...day,
      week: Math.floor(position / 7),
      weekday: (date.getDay() + 6) % 7,
    }];
  });
}

export function memberIdentityMbti(tags: readonly MemberIdentityTag[]): { text: string; title: string } | undefined {
  const reports = tags.filter((tag) => tag.category === 'identity'
    && tag.status === 'confirmed'
    && tag.origin === 'self_report'
    && /^[IE][NS][TF][JP]$/iu.test(tag.text));
  if (reports.length === 0) return undefined;
  const positions = Array.from({ length: 4 }, (_, index) => {
    const counts = new Map<string, number>();
    for (const tag of reports) {
      const letter = tag.text.toUpperCase()[index];
      if (letter) counts.set(letter, (counts.get(letter) ?? 0) + tag.samples);
    }
    return counts;
  });
  const text = positions.map((counts) => counts.size === 1 ? counts.keys().next().value as string : '?').join('');
  const differing = positions.flatMap((counts, index) => counts.size < 2
    ? []
    : [`第${index + 1}位：${[...counts].map(([letter, count]) => `${letter} ${count} 次`).join('、')}`]);
  const title = differing.length > 0
    ? differing.join('；')
    : reports.map((tag) => `${tag.text.toUpperCase()} ${tag.samples} 次`).join('；');
  return { text, title };
}

export function recentTagFadeLabel(
  tag: { source: string; fadeAt: number | null },
  now: number,
): string | undefined {
  if (tag.source !== 'auto' || tag.fadeAt === null || !Number.isFinite(now)) return undefined;
  if (tag.fadeAt <= now) return '已淡出';
  return `${Math.ceil((tag.fadeAt - now) / DAY_MS)} 天后淡出`;
}

export function memberIdentityInjectionLabel(tag: { category: string; origin: string; status: string }): string | undefined {
  if (tag.category !== 'identity' || tag.origin !== 'inferred') return undefined;
  return tag.status === 'confirmed' ? '推测 · 已手动确认' : '推测 · 未注入';
}
