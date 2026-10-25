import type { MoodBand, ReserveBand } from '../../store/affect-repo.ts';
import { nextLevel, type HysteresisParams } from '../shared/hysteresis.ts';
import { resolveEnergyMultiplier, type PersonaEnergyMultipliers } from '../../persona/energy.ts';
import { moodRegionOf } from './emotions.ts';

// 情绪基线：valence 愉悦度 [-1, 1]，arousal 兴奋度 [0, 1]。
export const MOOD_BASELINE = { valence: 0.1, arousal: 0.4 } as const;
export const DEFAULT_SURFACE_HALF_LIFE_MIN = 40;
export const DEFAULT_AROUSAL_HALF_LIFE_MIN = 40;
export const DEFAULT_MOOD_HALF_LIFE_MIN = DEFAULT_SURFACE_HALF_LIFE_MIN;
export const DEFAULT_SURFACE_HOLD_SHAPE = 3;
export const DEFAULT_AROUSAL_HOLD_SHAPE = 2;
export const DEFAULT_RESERVE = 0.8;
export const RESERVE_BUFFER_RATIO = 0.85;
export const RESERVE_BUFFER_MAX = 0.05;
export const RESERVE_BUFFER_WATER_COST = 1.5;
export const RESERVE_RECOVERY_COST = 0.3;
export const RESERVE_STEP_MS = 15 * 60_000;

// 模型评估输出的变化范围；总波动由时窗软上限继续限制。
export const MAX_EVENT_DELTA = 0.3;
export const MAX_VALENCE_DELTA = MAX_EVENT_DELTA;
export const MAX_AROUSAL_DELTA = 0.3;
export const MAX_DOMINANCE_DELTA = 0.3;
export const MAX_RESERVE_DELTA = 0.15;
export const SENDER_VALENCE_WINDOW_MS = 60 * 60 * 1000;
export const SENDER_VALENCE_CAP = 0.8;
export const SENDER_RESERVE_CAP = 0.3;

// 档位防抖：静摩擦 0.05；换档后 5 分钟内滑动摩擦 0.02；decay 换档需当前档位已保持 10 分钟。
export const STATIC_FRICTION = 0.05;
export const SLIDING_FRICTION = 0.02;
export const SLIDING_FRICTION_WINDOW_MS = 5 * 60 * 1000;
export const MIN_BAND_DWELL_MS = 10 * 60 * 1000;
const MOOD_ANCHOR_EPSILON = 0.005;

export const MOOD_REGION_ORDER: readonly MoodBand[] = ['unpleasant', 'oppressed', 'calm', 'aroused', 'excited'];
export const RESERVE_BAND_ORDER: readonly ReserveBand[] = ['drained', 'tired', 'full'];
export const RESERVE_BAND_BOUNDS = [0.3, 0.6] as const;
const RESERVE_HYSTERESIS_PARAMS: HysteresisParams = {
  bounds: RESERVE_BAND_BOUNDS,
  staticMargin: 0.05,
  slidingMargin: 0.02,
  slidingWindowMs: SLIDING_FRICTION_WINDOW_MS,
  decayDwellMs: MIN_BAND_DWELL_MS,
};

export type EnergySource = 'inner' | 'outer' | 'mixed';

export interface MoodBandState {
  band: MoodBand;
  bandSince: number;
  lastBandChangeAt: number;
}

export interface ReserveBandState {
  band: ReserveBand;
  bandSince: number;
  lastBandChangeAt: number;
}

export interface MoodDynamicsState {
  valence: number;
  arousal: number;
  dominance: number;
  reserve: number;
  valenceD0?: number;
  valenceU?: number;
  arousalD0?: number;
  arousalU?: number;
  dominanceD0?: number;
  dominanceU?: number;
}

export interface AdvanceMoodStateOptions {
  from: number;
  to: number;
  baseline: { valence: number; arousal: number };
  surfaceHalfLifeMin: number;
  arousalHalfLifeMin: number;
  surfaceHoldShape?: number;
  arousalHoldShape?: number;
  energySource: EnergySource;
  energyMultipliers?: Partial<PersonaEnergyMultipliers>;
  lastReplyAt: number | null;
  companionshipPositive: boolean;
}

export interface MoodHistoryEntry {
  time: number;
  senderId: number | null;
  appliedDv: number;
}

export interface ReserveHistoryEntry {
  time: number;
  senderId: number | null;
  appliedDr: number;
}

export interface BufferedMoodDelta {
  surfaceDelta: number;
  absorbed: number;
  reserve: number;
}

export function bandOf(valence: number, arousal: number): MoodBand {
  return moodRegionOf(valence, arousal);
}

// 读取时按真实时间衰减：x = base + (x0 − base) × 2^(−Δt / halfLife)。
export function decayValue(value: number, baseline: number, elapsedMs: number, halfLifeMin: number): number {
  if (!(halfLifeMin > 0)) throw new RangeError('半衰期必须为正数');
  if (elapsedMs <= 0) return value;
  return baseline + (value - baseline) * 2 ** (-elapsedMs / (halfLifeMin * 60_000));
}

// Hill 停留曲线：u=1 时剩余偏移正好减半。
export function holdDecay(d0: number, u: number, n: number): number {
  if (!Number.isFinite(d0) || !Number.isFinite(u) || u < 0 || !Number.isFinite(n) || n <= 0) {
    throw new RangeError('Hill 曲线参数无效');
  }
  return d0 / (1 + u ** n);
}

export function reanchor(currentDelta: number, nextDelta: number, u: number, n: number): { d0: number; u: number } {
  if (!Number.isFinite(currentDelta) || !Number.isFinite(nextDelta) || !Number.isFinite(u) || u < 0) {
    throw new RangeError('情绪锚点参数无效');
  }
  if (Math.abs(nextDelta) < MOOD_ANCHOR_EPSILON) return { d0: 0, u: 0 };
  if (Math.abs(currentDelta) < MOOD_ANCHOR_EPSILON
    || currentDelta * nextDelta < 0
    || (currentDelta * nextDelta > 0 && Math.abs(nextDelta) > Math.abs(currentDelta))) {
    return { d0: nextDelta, u: 0 };
  }
  return { d0: nextDelta / holdDecay(1, u, n), u };
}

// 同一发送者过去 60 分钟的累计变化越大，后续事件的应用比例越低。
export function capSenderValenceDelta(
  delta: number,
  senderId: number | null,
  history: readonly MoodHistoryEntry[],
  now: number,
): number {
  if (senderId === null || delta === 0) return delta;
  const used = history
    .filter((entry) => entry.senderId === senderId
      && entry.time >= now - SENDER_VALENCE_WINDOW_MS
      && entry.time <= now)
    .reduce((sum, entry) => sum + Math.abs(entry.appliedDv), 0);
  return delta * Math.max(0, 1 - used / SENDER_VALENCE_CAP);
}

export function capSenderReserveDelta(
  delta: number,
  senderId: number | null,
  history: readonly ReserveHistoryEntry[],
  now: number,
  energyMultipliers?: Partial<PersonaEnergyMultipliers>,
): number {
  if (senderId === null || delta === 0) return delta;
  const cap = SENDER_RESERVE_CAP * resolveEnergyMultiplier(energyMultipliers, 'senderHourlyCap');
  if (cap <= 0) return 0;
  const used = history
    .filter((entry) => entry.senderId === senderId
      && entry.time >= now - SENDER_VALENCE_WINDOW_MS
      && entry.time <= now)
    .reduce((sum, entry) => sum + Math.abs(entry.appliedDr), 0);
  return delta * Math.max(0, 1 - used / cap);
}

export function bufferNegativeDelta(
  delta: number,
  reserve: number,
  energyMultipliers?: Partial<PersonaEnergyMultipliers>,
): BufferedMoodDelta {
  const water = Math.max(0, Math.min(1, reserve));
  if (delta >= 0) return { surfaceDelta: delta, absorbed: 0, reserve: water };
  const absorbed = Math.min(
    Math.abs(delta) * RESERVE_BUFFER_RATIO * Math.min(1, water / 0.5),
    RESERVE_BUFFER_MAX,
  );
  return {
    surfaceDelta: delta + absorbed,
    absorbed,
    reserve: Math.max(0, water - absorbed * RESERVE_BUFFER_WATER_COST
      * resolveEnergyMultiplier(energyMultipliers, 'bufferCost')),
  };
}

export function surfaceHalfLifeMin(
  reserve: number,
  baseHalfLifeMin = DEFAULT_SURFACE_HALF_LIFE_MIN,
): number {
  if (!(baseHalfLifeMin > 0)) throw new RangeError('表层半衰期必须为正数');
  const water = Math.max(0, Math.min(1, reserve));
  return baseHalfLifeMin * 1.4 / (0.4 + water);
}

export function applyArousalDelta(current: number, delta: number): number {
  const applied = delta > 0 ? delta * (1 - current) : delta;
  return Math.max(0, Math.min(1, current + applied));
}

export function applyDominanceDelta(current: number, delta: number): number {
  return Math.max(-1, Math.min(1, current + delta));
}

export function recoverReserve(input: {
  reserve: number;
  energySource: EnergySource;
  elapsedMs: number;
  company: boolean;
  sad: boolean;
  energyMultipliers?: Partial<PersonaEnergyMultipliers>;
}): number {
  const reserve = Math.max(0, Math.min(1, input.reserve));
  if (input.sad || input.elapsedMs <= 0) return reserve;
  const halfLifeHours = input.energySource === 'inner'
    ? input.company ? null : 2
    : input.energySource === 'outer'
      ? input.company ? 2 : 8
      : 4;
  if (halfLifeHours === null) return reserve;
  const multiplier = resolveEnergyMultiplier(
    input.energyMultipliers,
    input.company ? 'companyRecovery' : 'aloneRecovery',
  );
  if (multiplier <= 0) return reserve;
  const next = 1 - (1 - reserve) * 2 ** (-input.elapsedMs / (halfLifeHours / multiplier * 60 * 60_000));
  return Math.max(0, Math.min(1, next));
}

export function isCompanionshipActive(
  lastReplyAt: number | null,
  now: number,
  averageAppraiseValence: number,
): boolean {
  return lastReplyAt !== null
    && lastReplyAt <= now
    && now - lastReplyAt <= 15 * 60_000
    && averageAppraiseValence >= 0;
}

export function isSuccessfulAppraisal(event: { source?: string; appraisalValid?: boolean | null }): boolean {
  return event.source === 'appraise' && event.appraisalValid === true;
}

export function advanceMoodState(state: MoodDynamicsState, input: AdvanceMoodStateOptions): MoodDynamicsState {
  if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.to < input.from) {
    throw new RangeError('情绪状态时间范围无效');
  }
  if (!(input.surfaceHalfLifeMin > 0)) throw new RangeError('表层半衰期必须为正数');
  if (!(input.arousalHalfLifeMin > 0)) throw new RangeError('兴奋度半衰期必须为正数');
  const surfaceHoldShape = input.surfaceHoldShape ?? DEFAULT_SURFACE_HOLD_SHAPE;
  const arousalHoldShape = input.arousalHoldShape ?? DEFAULT_AROUSAL_HOLD_SHAPE;
  if (!Number.isFinite(surfaceHoldShape) || surfaceHoldShape <= 0
    || !Number.isFinite(arousalHoldShape) || arousalHoldShape <= 0) {
    throw new RangeError('停留感形状参数必须为正数');
  }
  const dominance = Number.isFinite(state.dominance) ? state.dominance : 0;
  let current = {
    valence: state.valence,
    arousal: state.arousal,
    dominance,
    reserve: Math.max(0, Math.min(1, state.reserve)),
    valenceD0: state.valenceD0 ?? state.valence - input.baseline.valence,
    valenceU: state.valenceU ?? 0,
    arousalD0: state.arousalD0 ?? state.arousal - input.baseline.arousal,
    arousalU: state.arousalU ?? 0,
    dominanceD0: state.dominanceD0 ?? dominance,
    dominanceU: state.dominanceU ?? 0,
  };
  let cursor = input.from;
  while (cursor < input.to) {
    let end = Math.min(input.to, cursor + RESERVE_STEP_MS);
    const replyBoundaries = [input.lastReplyAt, input.lastReplyAt === null ? null : input.lastReplyAt + 15 * 60_000]
      .filter((time): time is number => time !== null && time > cursor && time < end);
    if (replyBoundaries.length > 0) end = Math.min(end, ...replyBoundaries);
    const elapsedMs = end - cursor;
    const previousValence = current.valence;
    current.valenceU += elapsedMs / (surfaceHalfLifeMin(current.reserve, input.surfaceHalfLifeMin) * 60_000);
    current.arousalU += elapsedMs / input.arousalHalfLifeMin / 60_000;
    current.dominanceU += elapsedMs / input.arousalHalfLifeMin / 60_000;
    current.valence = input.baseline.valence + holdDecay(current.valenceD0, current.valenceU, surfaceHoldShape);
    current.arousal = input.baseline.arousal + holdDecay(current.arousalD0, current.arousalU, arousalHoldShape);
    current.dominance = holdDecay(current.dominanceD0, current.dominanceU, arousalHoldShape);
    if (previousValence < input.baseline.valence) {
      const recovered = Math.max(0, current.valence - previousValence);
      current.reserve = Math.max(0, current.reserve - recovered * RESERVE_RECOVERY_COST
        * resolveEnergyMultiplier(input.energyMultipliers, 'calmRecoveryCost'));
    }
    const company = input.companionshipPositive
      && input.lastReplyAt !== null
      && cursor >= input.lastReplyAt
      && cursor < input.lastReplyAt + 15 * 60_000;
    current.reserve = recoverReserve({
      reserve: current.reserve,
      energySource: input.energySource,
      elapsedMs,
      company,
      sad: previousValence < input.baseline.valence - 0.15,
      energyMultipliers: input.energyMultipliers,
    });
    cursor = end;
  }
  return current;
}

export function reserveBandOf(reserve: number): ReserveBand {
  if (reserve < RESERVE_BAND_BOUNDS[0]) return 'drained';
  if (reserve < RESERVE_BAND_BOUNDS[1]) return 'tired';
  return 'full';
}

export function nextReserveBand(
  state: ReserveBandState,
  reserve: number,
  now: number,
  cause: 'event' | 'decay',
): ReserveBand {
  const current = RESERVE_BAND_ORDER.indexOf(state.band);
  const next = nextLevel({
    current,
    since: state.bandSince,
    lastChangeAt: state.lastBandChangeAt,
  }, reserve, now, cause, RESERVE_HYSTERESIS_PARAMS);
  return RESERVE_BAND_ORDER[next] ?? state.band;
}

export function clampMood(valence: number, arousal: number, dominance = 0): { valence: number; arousal: number; dominance: number } {
  return {
    valence: Math.max(-1, Math.min(1, valence)),
    arousal: Math.max(0, Math.min(1, arousal)),
    dominance: Math.max(-1, Math.min(1, dominance)),
  };
}

export {
  buildEmotionLibrary,
  resolveConfiguredMoodEmotions,
  defaultEmotionEdge,
  dwellMultiplierForMessageId,
  emotionIntensity,
  moodRegionOf,
  padDistance,
  resolveMoodEmotions,
  DEFAULT_CUSTOM_EMOTION_POINT,
  DEFAULT_EMOTION_LIBRARY,
  DEFAULT_SUB_MAX,
  DEFAULT_SUB_THRESHOLD,
} from './emotions.ts';
export type {
  EmotionCoordinateOverrides,
  EmotionEdge,
  EmotionEdgeOverrides,
  ConfiguredMoodSettings,
  PadEmotion,
  MoodRegion,
  ResolveMoodEmotionsInput,
  ResolvedMoodEmotions,
} from './emotions.ts';
