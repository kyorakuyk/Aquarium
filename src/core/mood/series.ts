import type { MoodBand, StoredMoodEvent } from '../../store/affect-repo.ts';
import {
  advanceMoodState,
  isCompanionshipActive,
  isSuccessfulAppraisal,
  type EnergySource,
} from './core.ts';
import { moodRegionOf } from './emotions.ts';
import type { PersonaEnergyMultipliers } from '../../persona/energy.ts';

export const MOOD_SERIES_INTERVAL_MS = 15 * 60_000;

export interface MoodSeriesPoint {
  time: number;
  valence: number;
  arousal: number;
  dominance: number;
  region: MoodBand;
  reserve: number;
  absorbed: number;
  event: boolean;
}

export interface MoodSeriesAnchor {
  time: number;
  valenceAfter: number | null;
  arousalAfter: number | null;
  dominanceAfter?: number | null;
  reserveAfter?: number | null;
  source?: StoredMoodEvent['source'];
  appraisalValid?: boolean | null;
  reason?: string;
  dv?: number;
}

export function buildMoodSeriesPoints(input: {
  from: number;
  to: number;
  surfaceHalfLifeMin: number;
  arousalHalfLifeMin: number;
  energySource: EnergySource;
  energyMultipliers?: Partial<PersonaEnergyMultipliers>;
  baseline: { valence: number; arousal: number };
  initialReserve: number;
  previous?: MoodSeriesAnchor;
  events: readonly StoredMoodEvent[];
  replyTimes: readonly number[];
  intervalMs?: number;
}): MoodSeriesPoint[] {
  const intervalMs = input.intervalMs ?? MOOD_SERIES_INTERVAL_MS;
  if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.to < input.from) {
    throw new RangeError('情绪序列时间范围无效');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('情绪序列间隔必须为正数');
  if (!(input.surfaceHalfLifeMin > 0) || !(input.arousalHalfLifeMin > 0)) {
    throw new RangeError('半衰期必须为正数');
  }
  if (!Number.isFinite(input.initialReserve) || input.initialReserve < 0 || input.initialReserve > 1) {
    throw new RangeError('初始心灵能量必须在 0 到 1 之间');
  }

  const initialTime = input.previous?.time !== undefined && input.previous.time <= input.from
    ? input.previous.time
    : input.from;
  const historyFrom = Math.min(initialTime, input.from) - 15 * 60_000;
  const historyEvents = input.events
    .filter((event) => event.time >= historyFrom && event.time <= input.to)
    .sort((left, right) => left.time - right.time || left.id - right.id);
  const events = historyEvents.filter((event) => event.time >= input.from);
  const eventTimes = new Set(events.map((event) => event.time));
  const absorbedAt = new Map<number, number>();
  for (const event of events) {
    if (event.absorbed > 0) absorbedAt.set(event.time, (absorbedAt.get(event.time) ?? 0) + event.absorbed);
  }
  const replyTimes = [...new Set(input.replyTimes
    .filter((time) => Number.isFinite(time) && time >= historyFrom && time <= input.to))]
    .sort((left, right) => left - right);
  const sampleTimes = new Set<number>([input.from, input.to]);
  for (let time = input.from + intervalMs; time < input.to; time += intervalMs) sampleTimes.add(time);
  for (const time of eventTimes) sampleTimes.add(time);

  let state = {
    time: initialTime,
    valence: input.previous?.time !== undefined && input.previous.time <= input.from && input.previous.valenceAfter !== null
      ? input.previous.valenceAfter
      : input.baseline.valence,
    arousal: input.previous?.time !== undefined && input.previous.time <= input.from && input.previous.arousalAfter !== null
      ? input.previous.arousalAfter
      : input.baseline.arousal,
    dominance: input.previous?.time !== undefined && input.previous.time <= input.from
      ? input.previous.dominanceAfter ?? 0
      : 0,
    reserve: input.previous?.time !== undefined && input.previous.time <= input.from
      ? input.previous.reserveAfter ?? 0.8
      : input.initialReserve,
    lastReplyAt: replyTimes.filter((time) => time <= initialTime).at(-1) ?? null,
  };
  const appraisalHistory = historyEvents
    .filter((event) => event.time <= initialTime
      && event.time < input.from
      && isSuccessfulAppraisal(event))
    .map((event) => ({ time: event.time, dv: event.dv }));
  if (input.previous?.time !== undefined
    && input.previous.time < input.from
    && isSuccessfulAppraisal(input.previous)
    && !appraisalHistory.some((event) => event.time === input.previous?.time && event.dv === (input.previous?.dv ?? 0))) {
    appraisalHistory.push({ time: input.previous.time, dv: input.previous.dv ?? 0 });
  }
  let nextEvent = 0;
  let nextReply = replyTimes.findIndex((time) => time > initialTime);
  if (nextReply < 0) nextReply = replyTimes.length;

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
      const companionshipPositive = averageAppraiseValence !== undefined
        && isCompanionshipActive(state.lastReplyAt, from, averageAppraiseValence);
      const dynamics = advanceMoodState({
        valence: state.valence,
        arousal: state.arousal,
        dominance: state.dominance,
        reserve: state.reserve,
      }, {
        from,
        to: segmentTo,
        baseline: input.baseline,
        surfaceHalfLifeMin: input.surfaceHalfLifeMin,
        arousalHalfLifeMin: input.arousalHalfLifeMin,
        energySource: input.energySource,
        energyMultipliers: input.energyMultipliers,
        lastReplyAt: state.lastReplyAt,
        companionshipPositive,
      });
      state = { ...state, ...dynamics, time: segmentTo };
    }
  }

  const points: MoodSeriesPoint[] = [];
  for (const time of [...sampleTimes].sort((left, right) => left - right)) {
    while (true) {
      const event = events[nextEvent];
      const replyTime = replyTimes[nextReply];
      const eventTime = event?.time ?? Infinity;
      const nextTime = Math.min(eventTime, replyTime ?? Infinity);
      if (nextTime > time) break;
      advance(nextTime);
      if (replyTime !== undefined && replyTime <= eventTime) {
        state = { ...state, time: replyTime, lastReplyAt: replyTime };
        nextReply += 1;
        continue;
      }
      if (!event) break;
      state = {
        ...state,
        time: event.time,
        valence: event.valenceAfter ?? state.valence,
        arousal: event.arousalAfter ?? state.arousal,
        dominance: event.dominanceAfter,
        reserve: event.reserveAfter ?? 0.8,
      };
      if (isSuccessfulAppraisal(event)) {
        appraisalHistory.push({ time: event.time, dv: event.dv });
      }
      nextEvent += 1;
    }
    advance(time);
    points.push({
      time,
      valence: state.valence,
      arousal: state.arousal,
      dominance: state.dominance,
      region: moodRegionOf(state.valence, state.arousal),
      reserve: state.reserve,
      absorbed: absorbedAt.get(time) ?? 0,
      event: eventTimes.has(time),
    });
  }
  return points;
}
