import type { MoodBand } from '../../store/affect-repo.ts';
import { nextLevel, type HysteresisParams } from '../shared/hysteresis.ts';

// 情绪基线：valence 愉悦度 [-1, 1]，arousal 兴奋度 [0, 1]。
export const MOOD_BASELINE = { valence: 0.1, arousal: 0.4 } as const;
export const DEFAULT_MOOD_HALF_LIFE_MIN = 30;

// 上限：单次事件 |Δ| ≤ 0.15（由模型 JSON 范围保证）；同一发送者 60 分钟累计 |Δvalence| ≤ 0.3。
export const MAX_EVENT_DELTA = 0.15;
export const SENDER_VALENCE_WINDOW_MS = 60 * 60 * 1000;
export const SENDER_VALENCE_CAP = 0.3;

// 档位防抖：静摩擦 0.08；换档后 5 分钟内滑动摩擦 0.02；decay 换档需当前档位已保持 10 分钟。
export const STATIC_FRICTION = 0.08;
export const SLIDING_FRICTION = 0.02;
export const SLIDING_FRICTION_WINDOW_MS = 5 * 60 * 1000;
export const MIN_BAND_DWELL_MS = 10 * 60 * 1000;

export const BAND_ORDER: readonly MoodBand[] = ['low', 'annoyed', 'calm', 'happy', 'excited'];
export const MOOD_BAND_BOUNDS = [-0.5, -0.15, 0.15, 0.5] as const;
const MOOD_HYSTERESIS_PARAMS: HysteresisParams = {
  bounds: MOOD_BAND_BOUNDS,
  staticMargin: STATIC_FRICTION,
  slidingMargin: SLIDING_FRICTION,
  slidingWindowMs: SLIDING_FRICTION_WINDOW_MS,
  decayDwellMs: MIN_BAND_DWELL_MS,
};

export interface MoodBandState {
  band: MoodBand;
  bandSince: number;
  lastBandChangeAt: number;
}

export interface MoodHistoryEntry {
  time: number;
  senderId: number | null;
  appliedDv: number;
}

export function bandOf(valence: number): MoodBand {
  if (valence < -0.5) return 'low';
  if (valence < -0.15) return 'annoyed';
  if (valence < 0.15) return 'calm';
  if (valence < 0.5) return 'happy';
  return 'excited';
}

// 读取时按真实时间衰减：x = base + (x0 − base) × 2^(−Δt / halfLife)。
export function decayValue(value: number, baseline: number, elapsedMs: number, halfLifeMin: number): number {
  if (!(halfLifeMin > 0)) throw new RangeError('半衰期必须为正数');
  if (elapsedMs <= 0) return value;
  return baseline + (value - baseline) * 2 ** (-elapsedMs / (halfLifeMin * 60_000));
}

// 同一发送者过去 60 分钟内累计 |Δvalence| 不超过 0.3，超出部分截掉。
export function capSenderValenceDelta(
  delta: number,
  senderId: number | null,
  history: readonly MoodHistoryEntry[],
  now: number,
): number {
  if (senderId === null || delta === 0) return delta;
  const used = history
    .filter((entry) => entry.senderId === senderId && now - entry.time <= SENDER_VALENCE_WINDOW_MS)
    .reduce((sum, entry) => sum + Math.abs(entry.appliedDv), 0);
  const remaining = Math.max(0, SENDER_VALENCE_CAP - used);
  if (Math.abs(delta) <= remaining) return delta;
  return Math.sign(delta) * remaining;
}

export function clampMood(valence: number, arousal: number): { valence: number; arousal: number } {
  return {
    valence: Math.max(-1, Math.min(1, valence)),
    arousal: Math.max(0, Math.min(1, arousal)),
  };
}

// 档位防抖：只有越过当前档位边界并超出摩擦余量才换档，新档位取 v 实际所在档位（可以一次跨多档）。
export function nextBand(
  state: MoodBandState,
  valence: number,
  now: number,
  cause: 'event' | 'decay',
): MoodBand {
  const current = BAND_ORDER.indexOf(state.band);
  const next = nextLevel({
    current,
    since: state.bandSince,
    lastChangeAt: state.lastBandChangeAt,
  }, valence, now, cause, MOOD_HYSTERESIS_PARAMS);
  return BAND_ORDER[next] ?? state.band;
}
