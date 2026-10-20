import { resolveSession } from '../../config/resolve.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import type { TagEvidence, TagRecord } from '../../store/affect-repo.ts';
import type { MessageStorageRecord, StoreRepository } from '../../store/repository.ts';
import type { ActivitySuggestionRepository } from '../../store/activity-suggestion-repo.ts';
import { normalizeTagText } from '../impressions/tags.ts';
import { parseSessionId } from '../sessions.ts';
import { resolveMode } from '../activity/mode.ts';
import {
  buildActivityResponse,
  buildActivitySuggestion,
  localDateKey,
  localStartOfDays,
  type ActivitySuggestion,
} from './presence.ts';

export interface ProfileActivityServiceOptions {
  repository: StoreRepository;
  suggestionRepository: ActivitySuggestionRepository;
  getConfig: () => AquariumConfig;
  now?: () => number;
}

export interface ProfileActivityService {
  recomputeSchedules(at?: number): Promise<void>;
  suggestionForSession(sessionId: string, at?: number): ActivitySuggestion | null;
  dismissSuggestion(sessionId: string, windowKey: string, at?: number): boolean;
}

const SCHEDULE_LABELS = ['夜猫子', '周末更活跃', '早上不在线'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ActivityMetrics {
  total: number;
  nightOwlRatio: number;
  weekendToWeekdayRatio: number;
  morningRatio: number;
  weekendToWeekdaySnapshot: number | null;
}

interface LocalDayCounts {
  weekend: number;
  weekday: number;
}

function localDayNumber(value: number): number {
  const date = new Date(value);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function localDaysBetween(previous: number, current: number): number {
  return localDayNumber(current) - localDayNumber(previous);
}

function localDayCounts(now: number, dayCount: number): LocalDayCounts {
  const date = new Date(localStartOfDays(now, dayCount));
  let weekend = 0;
  let weekday = 0;
  for (let index = 0; index < dayCount; index += 1) {
    const day = date.getDay();
    if (day === 0 || day === 6) weekend += 1;
    else weekday += 1;
    date.setDate(date.getDate() + 1);
  }
  return { weekend, weekday };
}

function metricsFor(
  messages: readonly MessageStorageRecord[],
  days: LocalDayCounts,
): ActivityMetrics {
  let nightMessages = 0;
  let morningMessages = 0;
  let weekendMessages = 0;
  let weekdayMessages = 0;
  for (const message of messages) {
    const hour = new Date(message.time).getHours();
    const day = new Date(message.time).getDay();
    if (hour >= 23 || hour < 3) nightMessages += 1;
    if (hour >= 6 && hour < 10) morningMessages += 1;
    if (day === 0 || day === 6) weekendMessages += 1;
    else weekdayMessages += 1;
  }
  const total = messages.length;
  const weekendDaily = days.weekend === 0 ? 0 : weekendMessages / days.weekend;
  const weekdayDaily = days.weekday === 0 ? 0 : weekdayMessages / days.weekday;
  const weekendToWeekdayRatio = weekdayDaily === 0
    ? weekendDaily > 0 ? Number.POSITIVE_INFINITY : 0
    : weekendDaily / weekdayDaily;
  return {
    total,
    nightOwlRatio: total === 0 ? 0 : nightMessages / total,
    weekendToWeekdayRatio,
    morningRatio: total === 0 ? 0 : morningMessages / total,
    weekendToWeekdaySnapshot: Number.isFinite(weekendToWeekdayRatio) ? weekendToWeekdayRatio : null,
  };
}

function qualifies(metrics: ActivityMetrics, config: AquariumConfig, label: typeof SCHEDULE_LABELS[number]): boolean {
  const thresholds = config.profile.schedule;
  if (metrics.total < thresholds.minimumMessages) return false;
  if (label === '夜猫子') return metrics.nightOwlRatio >= thresholds.nightOwlRatio;
  if (label === '周末更活跃') return metrics.weekendToWeekdayRatio >= thresholds.weekendActiveRatio;
  return metrics.total >= thresholds.morningMinimumMessages
    && metrics.morningRatio <= thresholds.morningRatio;
}

function snapshotEvidence(
  label: typeof SCHEDULE_LABELS[number],
  metrics: ActivityMetrics,
  at: number,
  matches: boolean,
): TagEvidence[] {
  const date = localDateKey(at);
  return [{
    messageId: `activity:${date}:${label}`,
    time: at,
    quote: JSON.stringify({
      date,
      total: metrics.total,
      nightOwlRatio: metrics.nightOwlRatio,
      weekendToWeekdayRatio: metrics.weekendToWeekdaySnapshot,
      morningRatio: metrics.morningRatio,
      matches,
    }),
  }];
}

function activityTag(
  account: number,
  sessionId: string,
  userId: number,
  label: typeof SCHEDULE_LABELS[number],
  metrics: ActivityMetrics,
  at: number,
): TagRecord {
  return {
    account,
    sessionId,
    userId,
    text: label,
    norm: normalizeTagText(label),
    category: 'schedule',
    subject: null,
    polarity: null,
    origin: 'stats',
    locked: false,
    status: 'candidate',
    source: 'auto',
    samples: 1,
    evidence: snapshotEvidence(label, metrics, at, true),
    firstSeen: at,
    lastSeen: at,
    supersededBy: null,
    updatedAt: at,
  };
}

function hasActiveModeInWindow(
  settings: ReturnType<typeof resolveSession>,
  suggestion: ActivitySuggestion,
  at: number,
): boolean {
  const [hour, minute] = suggestion.from.split(':').map(Number);
  const start = new Date(at);
  start.setHours(hour, minute, 0, 0);
  for (let offset = 0; offset < 180; offset += 1) {
    const sample = new Date(start);
    sample.setMinutes(start.getMinutes() + offset);
    if (resolveMode(settings, sample.getTime()) === 'active') return true;
  }
  return false;
}

export function createProfileActivityService(options: ProfileActivityServiceOptions): ProfileActivityService {
  const now = options.now ?? Date.now;

  async function recomputeSchedules(at = now()): Promise<void> {
    if (!Number.isFinite(at)) throw new RangeError('作息统计时点无效');
    const config = options.getConfig();
    const from = localStartOfDays(at, 90);
    const days = localDayCounts(at, 90);
    for (const sessionId of options.repository.profileActivitySessions(from, at)) {
      const key = parseSessionId(sessionId);
      if (!key || key.kind !== 'group') continue;
      const messages = options.repository.messagesInRange(sessionId, from, at)
        .filter((message) => !message.isSelf);
      const byUser = new Map<number, MessageStorageRecord[]>();
      for (const message of messages) {
        const userMessages = byUser.get(message.senderId) ?? [];
        userMessages.push(message);
        byUser.set(message.senderId, userMessages);
      }

      const activityTags = options.repository.listTagsForSession(key.account, sessionId)
        .filter((tag) => tag.origin === 'stats' && tag.category === 'schedule' && tag.userId !== null);
      const userIds = new Set<number>([
        ...byUser.keys(),
        ...activityTags.map((tag) => tag.userId as number),
      ]);
      for (const userId of userIds) {
        const userMessages = byUser.get(userId) ?? [];
        const metrics = metricsFor(userMessages, days);
        const userTags = activityTags.filter((tag) => tag.userId === userId);
        for (const label of SCHEDULE_LABELS) {
          const existing = userTags.find((tag) => tag.text === label);
          if (existing?.status === 'rejected' || existing?.status === 'superseded') continue;
          const day = localDateKey(at);
          if (existing && localDateKey(existing.updatedAt) === day) continue;
          const matches = qualifies(metrics, config, label);
          const evidence = snapshotEvidence(label, metrics, at, matches);
          if (matches) {
            if (!existing) {
              options.repository.insertTag(activityTag(key.account, sessionId, userId, label, metrics, at));
              continue;
            }
            const gap = localDaysBetween(existing.lastSeen, at);
            const samples = gap === 1 ? existing.samples + 1 : 1;
            const status = existing.status === 'confirmed' || samples >= 2 ? 'confirmed' : 'candidate';
            options.repository.updateTag(existing.id, {
              samples,
              status,
              evidence,
              lastSeen: at,
              updatedAt: at,
            });
            continue;
          }
          if (!existing) continue;
          if (localDaysBetween(existing.lastSeen, at) >= 3) {
            options.repository.deleteActivityTag(existing.id);
          } else {
            options.repository.updateTag(existing.id, { samples: 0, evidence, updatedAt: at });
          }
        }
      }
    }
  }

  function suggestionForSession(sessionId: string, at = now()): ActivitySuggestion | null {
    if (!Number.isFinite(at)) throw new RangeError('活动建议时点无效');
    const key = parseSessionId(sessionId);
    if (!key || key.kind !== 'group') return null;
    const from = localStartOfDays(at, 90);
    const messages = options.repository.messagesInRange(sessionId, from, at);
    const activity = buildActivityResponse(messages, at, 'hour');
    const suggestion = buildActivitySuggestion(activity.buckets);
    if (!suggestion) return null;
    const settings = resolveSession(options.getConfig(), key);
    if (hasActiveModeInWindow(settings, suggestion, at)) return null;
    if (options.suggestionRepository.isDismissed(sessionId, suggestion.windowKey, at)) return null;
    return suggestion;
  }

  function dismissSuggestion(sessionId: string, windowKey: string, at = now()): boolean {
    const suggestion = suggestionForSession(sessionId, at);
    if (!suggestion || suggestion.windowKey !== windowKey) return false;
    options.suggestionRepository.dismiss(sessionId, windowKey, at);
    return true;
  }

  return { recomputeSchedules, suggestionForSession, dismissSuggestion };
}
