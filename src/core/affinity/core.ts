import { nextLevel, type HysteresisCause, type HysteresisState } from '../shared/hysteresis.ts';

export type AffinityLevel =
  | 'enemy' | 'loathe' | 'dislike' | 'uncomfortable' | 'distant'
  | 'unfamiliar' | 'acquaintance' | 'ordinary_friend' | 'more_than_friends' | 'lover';
export type AffinityEventSource = 'appraise' | 'called' | 'manual' | 'band';

export interface AffinityTiers {
  positive: readonly [number, number, number, number];
  negative: readonly [number, number, number, number];
}

export interface AffinityHistoryEntry {
  time: number;
  source: AffinityEventSource;
  applied: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const AFFINITY_LEVELS: readonly AffinityLevel[] = [
  'enemy', 'loathe', 'dislike', 'uncomfortable', 'distant',
  'unfamiliar', 'acquaintance', 'ordinary_friend', 'more_than_friends', 'lover',
];
const LEVELS = AFFINITY_LEVELS;
export const DEFAULT_AFFINITY_TIERS: AffinityTiers = {
  positive: [15, 35, 60, 85],
  negative: [-85, -60, -35, -15],
};
const LEVEL_HYSTERESIS = {
  staticMargin: 3,
  slidingMargin: 1,
  slidingWindowMs: DAY_MS,
  decayDwellMs: 3 * DAY_MS,
} as const;

function isSameLocalDate(firstAt: number, secondAt: number): boolean {
  const first = new Date(firstAt);
  const second = new Date(secondAt);
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

export function appraiseAffinityDelta(appliedDv: number): number {
  return Math.max(-3, Math.min(3, appliedDv * 20));
}

export function applyDailyAffinityCap(
  delta: number,
  history: readonly AffinityHistoryEntry[],
  now: number,
): number {
  const today = history.filter((event) => event.source !== 'manual' && isSameLocalDate(event.time, now));
  if (delta > 0) {
    const used = today.reduce((sum, event) => sum + Math.max(0, event.applied), 0);
    return Math.min(delta, Math.max(0, 5 - used));
  }
  if (delta < 0) {
    const used = today.reduce((sum, event) => sum + Math.min(0, event.applied), 0);
    return Math.max(delta, Math.min(0, -8 - used));
  }
  return 0;
}

export function canCountCalledAffinity(history: readonly AffinityHistoryEntry[], now: number): boolean {
  return history.filter((event) => event.source === 'called' && isSameLocalDate(event.time, now)).length < 3;
}

export function decayAffinity(value: number, lastInteractionAt: number, now: number, start = 15): number {
  const elapsedDays = Math.floor((now - lastInteractionAt) / DAY_MS);
  if (elapsedDays <= 3) return value;
  const amount = elapsedDays - 3;
  if (value > start) return Math.max(start, value - amount);
  if (value < start) return Math.min(start, value + amount);
  return start;
}

function levelBounds(tiers: AffinityTiers): number[] {
  return [...tiers.negative, 0, ...tiers.positive];
}

export function affinityLevelOf(value: number, tiers: AffinityTiers = DEFAULT_AFFINITY_TIERS): AffinityLevel {
  if (value < 0) {
    for (let index = 0; index < tiers.negative.length; index += 1) {
      if (value < tiers.negative[index]!) return LEVELS[index]!;
    }
    return 'distant';
  }
  for (let index = 0; index < tiers.positive.length; index += 1) {
    if (value < tiers.positive[index]!) return LEVELS[index + 5]!;
  }
  return 'lover';
}

export function nextAffinityLevel(
  state: HysteresisState,
  value: number,
  now: number,
  cause: HysteresisCause,
  tiers: AffinityTiers = DEFAULT_AFFINITY_TIERS,
): AffinityLevel {
  const current = nextLevel(state, value, now, cause, { ...LEVEL_HYSTERESIS, bounds: levelBounds(tiers) });
  return LEVELS[current] ?? 'lover';
}
