import { nextLevel, type HysteresisCause, type HysteresisState } from '../shared/hysteresis.ts';

export type AffinityLevel = 'cold' | 'cool' | 'neutral' | 'warm' | 'close';
export type AffinityEventSource = 'appraise' | 'called' | 'manual' | 'band';

export interface AffinityHistoryEntry {
  time: number;
  source: AffinityEventSource;
  applied: number;
}

const BASELINE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEVELS: readonly AffinityLevel[] = ['cold', 'cool', 'neutral', 'warm', 'close'];
const LEVEL_BOUNDS = [20, 40, 60, 80] as const;
const LEVEL_HYSTERESIS = {
  bounds: LEVEL_BOUNDS,
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

export function decayAffinity(value: number, lastInteractionAt: number, now: number): number {
  const elapsedDays = Math.floor((now - lastInteractionAt) / DAY_MS);
  if (elapsedDays <= 3) return value;
  const amount = elapsedDays - 3;
  if (value > BASELINE) return Math.max(BASELINE, value - amount);
  if (value < BASELINE) return Math.min(BASELINE, value + amount);
  return BASELINE;
}

export function affinityLevelOf(value: number): AffinityLevel {
  let level = 0;
  for (const bound of LEVEL_BOUNDS) {
    if (value < bound) break;
    level += 1;
  }
  return LEVELS[level] ?? 'close';
}

export function nextAffinityLevel(
  state: HysteresisState,
  value: number,
  now: number,
  cause: HysteresisCause,
): AffinityLevel {
  const current = nextLevel(state, value, now, cause, LEVEL_HYSTERESIS);
  return LEVELS[current] ?? 'close';
}
