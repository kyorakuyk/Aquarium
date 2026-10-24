import type { AquariumConfig } from '../../config/schema.ts';
import type { MoodBand, MoodStateRecord, ReserveBand, StoredMoodEvent } from '../../store/affect-repo.ts';
import {
  advanceMoodState,
  bandOf,
  isSuccessfulAppraisal,
  reserveBandOf,
  type EnergySource,
} from './core.ts';
import type { PersonaEnergyMultipliers } from '../../persona/energy.ts';

export type MoodSettings = Pick<AquariumConfig['mood'],
  'baseline' | 'surfaceHalfLifeMin' | 'arousalHalfLifeMin' | 'reserve'>;

export interface ResolvedMoodState {
  valence: number;
  arousal: number;
  dominance: number;
  reserve: number;
  band: MoodBand;
  bandSince: number;
  lastBandChangeAt: number;
  mainEmotion: string | null;
  emotionSince: number | null;
  lastEmotionChangeAt: number | null;
  reserveBand: ReserveBand;
  reserveBandSince: number;
  reserveLastChangeAt: number;
  lastReplyAt: number | null;
  updatedAt: number;
}

export function resolveMoodState(input: {
  stored: MoodStateRecord | undefined;
  at: number;
  settings: MoodSettings;
  energySource: EnergySource;
  energyMultipliers?: Partial<PersonaEnergyMultipliers>;
  appraisalEvents: readonly Pick<StoredMoodEvent, 'time' | 'dv' | 'source' | 'appraisalValid'>[];
  replyTimes: readonly number[];
}): ResolvedMoodState {
  const { stored, at, settings, energySource } = input;
  if (!stored) {
    return {
      valence: settings.baseline.valence,
      arousal: settings.baseline.arousal,
      dominance: 0,
      reserve: settings.reserve.initial,
      band: bandOf(settings.baseline.valence, settings.baseline.arousal),
      bandSince: at,
      lastBandChangeAt: at,
      mainEmotion: null,
      emotionSince: null,
      lastEmotionChangeAt: null,
      reserveBand: reserveBandOf(settings.reserve.initial),
      reserveBandSince: at,
      reserveLastChangeAt: at,
      lastReplyAt: null,
      updatedAt: at,
    };
  }

  const resolvedAt = Math.max(at, stored.updatedAt);
  const historyFrom = stored.updatedAt - 15 * 60_000;
  const appraisalHistory = input.appraisalEvents
    .filter((event) => event.time >= historyFrom
      && event.time <= stored.updatedAt
      && isSuccessfulAppraisal(event))
    .map((event) => ({ time: event.time, dv: event.dv }));
  const replyTimes = [...new Set(input.replyTimes
    .filter((time) => Number.isFinite(time) && time >= historyFrom && time <= resolvedAt))]
    .sort((left, right) => left - right);
  const priorReplies = replyTimes.filter((time) => time <= stored.updatedAt);
  let state = {
    time: stored.updatedAt,
    valence: stored.valence,
    arousal: stored.arousal,
    dominance: stored.dominance,
    reserve: stored.reserve,
    lastReplyAt: priorReplies.at(-1) !== undefined
      && (stored.lastReplyAt === null || (priorReplies.at(-1) ?? -Infinity) > stored.lastReplyAt)
      ? priorReplies.at(-1) ?? null
      : stored.lastReplyAt,
  };
  const timeline = [
    ...replyTimes.filter((time) => time > stored.updatedAt)
      .map((time) => ({ time, kind: 'reply' as const })),
    ...input.appraisalEvents.filter((event) => event.time > stored.updatedAt
      && event.time <= resolvedAt
      && isSuccessfulAppraisal(event))
      .map((event) => ({ time: event.time, kind: 'appraisal' as const, dv: event.dv })),
  ].sort((left, right) => left.time - right.time
    || (left.kind === right.kind ? 0 : left.kind === 'reply' ? -1 : 1));

  function advance(to: number): void {
    while (to > state.time) {
      const from = state.time;
      const replyExpiry = state.lastReplyAt !== null && state.lastReplyAt + 15 * 60_000 > from
        ? state.lastReplyAt + 15 * 60_000
        : Infinity;
      const appraisalExpiry = appraisalHistory.reduce((next, event) => {
        const expiry = event.time + 15 * 60_000 + 1;
        return expiry > from ? Math.min(next, expiry) : next;
      }, Infinity);
      const segmentTo = Math.min(to, replyExpiry, appraisalExpiry);
      const recentAppraisals = appraisalHistory.filter((event) => event.time >= from - 15 * 60_000 && event.time <= from);
      const averageAppraiseValence = recentAppraisals.length > 0
        ? recentAppraisals.reduce((sum, event) => sum + event.dv, 0) / recentAppraisals.length
        : undefined;
      const dynamics = advanceMoodState({
        valence: state.valence,
        arousal: state.arousal,
        dominance: state.dominance,
        reserve: state.reserve,
      }, {
        from,
        to: segmentTo,
        baseline: settings.baseline,
        surfaceHalfLifeMin: settings.surfaceHalfLifeMin,
        arousalHalfLifeMin: settings.arousalHalfLifeMin,
        energySource,
        energyMultipliers: input.energyMultipliers,
        lastReplyAt: state.lastReplyAt,
        companionshipPositive: averageAppraiseValence !== undefined && averageAppraiseValence >= 0,
      });
      state = { ...state, ...dynamics, time: segmentTo };
    }
  }

  for (const event of timeline) {
    advance(event.time);
    if (event.kind === 'reply') {
      state = { ...state, time: event.time, lastReplyAt: event.time };
    } else {
      appraisalHistory.push({ time: event.time, dv: event.dv });
    }
  }
  advance(resolvedAt);

  return {
    valence: state.valence,
    arousal: state.arousal,
    dominance: state.dominance,
    reserve: state.reserve,
    band: stored.band,
    bandSince: stored.bandSince,
    lastBandChangeAt: stored.lastBandChangeAt,
    mainEmotion: stored.mainEmotion,
    emotionSince: stored.emotionSince,
    lastEmotionChangeAt: stored.lastEmotionChangeAt,
    reserveBand: stored.reserveBand,
    reserveBandSince: stored.reserveBandSince ?? stored.updatedAt,
    reserveLastChangeAt: stored.reserveLastChangeAt ?? stored.updatedAt,
    lastReplyAt: state.lastReplyAt,
    updatedAt: resolvedAt,
  };
}
