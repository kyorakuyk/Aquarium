import type { MoodBand, StoredMoodEvent } from '../../store/affect-repo.ts';
import {
  DEFAULT_AROUSAL_HOLD_SHAPE,
  DEFAULT_SURFACE_HOLD_SHAPE,
  advanceMoodState,
  holdDecay,
  isCompanionshipActive,
  isSuccessfulAppraisal,
  surfaceHalfLifeMin,
  type EnergySource,
} from './core.ts';
import { moodRegionOf } from './emotions.ts';
import type { PersonaEnergyMultipliers } from '../../persona/energy.ts';

export const MOOD_SERIES_INTERVAL_MS = 5 * 60_000;
const LONG_MOOD_SERIES_INTERVAL_MS = 15 * 60_000;
const LONG_MOOD_SERIES_WINDOW_MS = 12 * 60 * 60_000;

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
  valenceUAfter?: number | null;
  arousalAfter: number | null;
  arousalUAfter?: number | null;
  dominanceAfter?: number | null;
  dominanceUAfter?: number | null;
  reserveAfter?: number | null;
  source?: StoredMoodEvent['source'];
  appraisalValid?: boolean | null;
  reason?: string;
  dv?: number;
}

interface MoodSeriesState {
  time: number;
  valence: number;
  arousal: number;
  dominance: number;
  valenceD0: number;
  valenceU: number;
  arousalD0: number;
  arousalU: number;
  dominanceD0: number;
  dominanceU: number;
  reserve: number;
  lastReplyAt: number | null;
}

interface MoodSeriesReplay {
  state: MoodSeriesState;
  appraisalHistory: Array<{ time: number; dv: number }>;
  nextEvent: number;
  nextReply: number;
}

function restoreAnchor(value: number, baseline: number, uAfter: number | null | undefined, shape: number) {
  const u = typeof uAfter === 'number' && Number.isFinite(uAfter) && uAfter >= 0 ? uAfter : 0;
  return { d0: (value - baseline) / holdDecay(1, u, shape), u };
}

export function buildMoodSeriesPoints(input: {
  from: number;
  to: number;
  surfaceHalfLifeMin: number;
  arousalHalfLifeMin: number;
  surfaceHoldShape?: number;
  arousalHoldShape?: number;
  energySource: EnergySource;
  energyMultipliers?: Partial<PersonaEnergyMultipliers>;
  baseline: { valence: number; arousal: number };
  initialReserve: number;
  previous?: MoodSeriesAnchor;
  events: readonly StoredMoodEvent[];
  replyTimes: readonly number[];
  intervalMs?: number;
  includeCurveSamples?: boolean;
}): MoodSeriesPoint[] {
  const defaultIntervalMs = input.to - input.from <= LONG_MOOD_SERIES_WINDOW_MS
    ? MOOD_SERIES_INTERVAL_MS
    : LONG_MOOD_SERIES_INTERVAL_MS;
  const intervalMs = input.intervalMs ?? defaultIntervalMs;
  const surfaceHoldShape = input.surfaceHoldShape ?? DEFAULT_SURFACE_HOLD_SHAPE;
  const arousalHoldShape = input.arousalHoldShape ?? DEFAULT_AROUSAL_HOLD_SHAPE;
  if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.to < input.from) {
    throw new RangeError('情绪序列时间范围无效');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('情绪序列间隔必须为正数');
  if (!(input.surfaceHalfLifeMin > 0) || !(input.arousalHalfLifeMin > 0)) {
    throw new RangeError('半衰期必须为正数');
  }
  if (!Number.isFinite(surfaceHoldShape) || surfaceHoldShape <= 0
    || !Number.isFinite(arousalHoldShape) || arousalHoldShape <= 0) {
    throw new RangeError('停留感形状参数必须为正数');
  }
  if (!Number.isFinite(input.initialReserve) || input.initialReserve < 0 || input.initialReserve > 1) {
    throw new RangeError('初始心灵能量必须在 0 到 1 之间');
  }

  const previousAnchor = input.previous?.time !== undefined && input.previous.time <= input.from
    ? input.previous
    : undefined;
  const initialTime = previousAnchor?.time ?? input.from;
  const previousValence = previousAnchor?.valenceAfter;
  const initialValence = typeof previousValence === 'number' ? previousValence : input.baseline.valence;
  const valenceAnchor = typeof previousValence === 'number'
    ? restoreAnchor(previousValence, input.baseline.valence, previousAnchor?.valenceUAfter, surfaceHoldShape)
    : { d0: 0, u: 0 };
  const previousArousal = previousAnchor?.arousalAfter;
  const initialArousal = typeof previousArousal === 'number' ? previousArousal : input.baseline.arousal;
  const arousalAnchor = typeof previousArousal === 'number'
    ? restoreAnchor(previousArousal, input.baseline.arousal, previousAnchor?.arousalUAfter, arousalHoldShape)
    : { d0: 0, u: 0 };
  const previousDominance = previousAnchor?.dominanceAfter;
  const initialDominance = typeof previousDominance === 'number' ? previousDominance : 0;
  const dominanceAnchor = typeof previousDominance === 'number'
    ? restoreAnchor(previousDominance, 0, previousAnchor?.dominanceUAfter, arousalHoldShape)
    : { d0: 0, u: 0 };
  const historyFrom = Math.min(initialTime, input.from) - 15 * 60_000;
  const historyEvents = input.events
    .filter((event) => event.time >= historyFrom && event.time <= input.to)
    .sort((left, right) => left.time - right.time || left.id - right.id);
  const events = historyEvents.filter((event) => event.time >= input.from);
  const eventTimes = new Set(events.map((event) => event.time));
  const gridTimes = new Set<number>([input.from, input.to]);
  for (let time = input.from + intervalMs; time < input.to; time += intervalMs) gridTimes.add(time);
  const mainTimes = new Set<number>([...gridTimes, ...eventTimes]);
  const absorbedAt = new Map<number, number>();
  for (const event of events) {
    if (event.absorbed > 0) absorbedAt.set(event.time, (absorbedAt.get(event.time) ?? 0) + event.absorbed);
  }
  const replyTimes = [...new Set(input.replyTimes
    .filter((time) => Number.isFinite(time) && time >= historyFrom && time <= input.to))]
    .sort((left, right) => left - right);

  const appraisalHistory = historyEvents
    .filter((event) => event.time <= initialTime
      && event.time < input.from
      && isSuccessfulAppraisal(event))
    .map((event) => ({ time: event.time, dv: event.dv }));
  if (previousAnchor
    && previousAnchor.time < input.from
    && isSuccessfulAppraisal(previousAnchor)
    && !appraisalHistory.some((event) => event.time === previousAnchor.time && event.dv === (previousAnchor.dv ?? 0))) {
    appraisalHistory.push({ time: previousAnchor.time, dv: previousAnchor.dv ?? 0 });
  }

  const replay: MoodSeriesReplay = {
    state: {
      time: initialTime,
      valence: initialValence,
      arousal: initialArousal,
      dominance: initialDominance,
      valenceD0: valenceAnchor.d0,
      valenceU: valenceAnchor.u,
      arousalD0: arousalAnchor.d0,
      arousalU: arousalAnchor.u,
      dominanceD0: dominanceAnchor.d0,
      dominanceU: dominanceAnchor.u,
      reserve: previousAnchor ? previousAnchor.reserveAfter ?? 0.8 : input.initialReserve,
      lastReplyAt: replyTimes.filter((time) => time <= initialTime).at(-1) ?? null,
    },
    appraisalHistory,
    nextEvent: 0,
    nextReply: 0,
  };
  replay.nextReply = replyTimes.findIndex((time) => time > initialTime);
  if (replay.nextReply < 0) replay.nextReply = replyTimes.length;

  function advanceState(state: MoodSeriesState, appraisalEvents: readonly { time: number; dv: number }[], to: number): MoodSeriesState {
    let current = state;
    while (to > current.time) {
      const from = current.time;
      const replyExpiry = current.lastReplyAt !== null && current.lastReplyAt + 15 * 60_000 > from
        ? current.lastReplyAt + 15 * 60_000
        : Infinity;
      const appraisalExpiry = appraisalEvents.reduce((next, event) => {
        const expiry = event.time + 15 * 60_000 + 1;
        return expiry > from ? Math.min(next, expiry) : next;
      }, Infinity);
      const segmentTo = Math.min(to, replyExpiry, appraisalExpiry);
      const recentAppraisals = appraisalEvents.filter((event) => event.time >= from - 15 * 60_000 && event.time <= from);
      const averageAppraiseValence = recentAppraisals.length > 0
        ? recentAppraisals.reduce((sum, event) => sum + event.dv, 0) / recentAppraisals.length
        : undefined;
      const companionshipPositive = averageAppraiseValence !== undefined
        && isCompanionshipActive(current.lastReplyAt, from, averageAppraiseValence);
      const dynamics = advanceMoodState({
        valence: current.valence,
        arousal: current.arousal,
        dominance: current.dominance,
        valenceD0: current.valenceD0,
        valenceU: current.valenceU,
        arousalD0: current.arousalD0,
        arousalU: current.arousalU,
        dominanceD0: current.dominanceD0,
        dominanceU: current.dominanceU,
        reserve: current.reserve,
      }, {
        from,
        to: segmentTo,
        baseline: input.baseline,
        surfaceHalfLifeMin: input.surfaceHalfLifeMin,
        arousalHalfLifeMin: input.arousalHalfLifeMin,
        surfaceHoldShape,
        arousalHoldShape,
        energySource: input.energySource,
        energyMultipliers: input.energyMultipliers,
        lastReplyAt: current.lastReplyAt,
        companionshipPositive,
      });
      current = {
        ...current,
        ...dynamics,
        time: segmentTo,
        valenceD0: dynamics.valenceD0 ?? current.valenceD0,
        valenceU: dynamics.valenceU ?? current.valenceU,
        arousalD0: dynamics.arousalD0 ?? current.arousalD0,
        arousalU: dynamics.arousalU ?? current.arousalU,
        dominanceD0: dynamics.dominanceD0 ?? current.dominanceD0,
        dominanceU: dynamics.dominanceU ?? current.dominanceU,
        lastReplyAt: current.lastReplyAt,
      };
    }
    return current;
  }

  function cloneReplay(value: MoodSeriesReplay): MoodSeriesReplay {
    return {
      state: { ...value.state },
      appraisalHistory: [...value.appraisalHistory],
      nextEvent: value.nextEvent,
      nextReply: value.nextReply,
    };
  }

  function advanceReplayTo(value: MoodSeriesReplay, to: number): void {
    while (true) {
      const event = events[value.nextEvent];
      const replyTime = replyTimes[value.nextReply];
      const eventTime = event?.time ?? Infinity;
      const nextTime = Math.min(eventTime, replyTime ?? Infinity);
      if (nextTime > to) break;
      value.state = advanceState(value.state, value.appraisalHistory, nextTime);
      if (replyTime !== undefined && replyTime <= eventTime) {
        value.state = { ...value.state, time: replyTime, lastReplyAt: replyTime };
        value.nextReply += 1;
        continue;
      }
      if (!event) break;
      const current = value.state;
      const valence = event.valenceAfter ?? current.valence;
      const arousal = event.arousalAfter ?? current.arousal;
      const dominance = event.dominanceAfter ?? current.dominance;
      const valenceAnchor = event.valenceAfter === null
        ? { d0: current.valenceD0, u: current.valenceU }
        : restoreAnchor(valence, input.baseline.valence, event.valenceUAfter, surfaceHoldShape);
      const arousalAnchor = event.arousalAfter === null
        ? { d0: current.arousalD0, u: current.arousalU }
        : restoreAnchor(arousal, input.baseline.arousal, event.arousalUAfter, arousalHoldShape);
      const dominanceAnchor = event.dominanceAfter === null || event.dominanceAfter === undefined
        ? { d0: current.dominanceD0, u: current.dominanceU }
        : restoreAnchor(dominance, 0, event.dominanceUAfter, arousalHoldShape);
      value.state = {
        ...current,
        time: event.time,
        valence,
        arousal,
        dominance,
        valenceD0: valenceAnchor.d0,
        valenceU: valenceAnchor.u,
        arousalD0: arousalAnchor.d0,
        arousalU: arousalAnchor.u,
        dominanceD0: dominanceAnchor.d0,
        dominanceU: dominanceAnchor.u,
        reserve: event.reserveAfter ?? 0.8,
      };
      if (isSuccessfulAppraisal(event)) {
        value.appraisalHistory.push({ time: event.time, dv: event.dv });
      }
      value.nextEvent += 1;
    }
    value.state = advanceState(value.state, value.appraisalHistory, to);
  }

  function pointAt(time: number, state: MoodSeriesState): MoodSeriesPoint {
    return {
      time,
      valence: state.valence,
      arousal: state.arousal,
      dominance: state.dominance,
      region: moodRegionOf(state.valence, state.arousal),
      reserve: state.reserve,
      absorbed: absorbedAt.get(time) ?? 0,
      event: eventTimes.has(time),
    };
  }

  const checkpoints: Array<{ time: number; replay: MoodSeriesReplay }> = [];
  const points = new Map<number, MoodSeriesPoint>();
  for (const time of [...mainTimes].sort((left, right) => left - right)) {
    advanceReplayTo(replay, time);
    points.set(time, pointAt(time, replay.state));
    checkpoints.push({ time, replay: cloneReplay(replay) });
  }

  if (input.includeCurveSamples !== false) {
    const curveTimes = new Set<number>();
    for (const event of events) {
      const eventCheckpoint = checkpoints.find((checkpoint) => checkpoint.time === event.time);
      const reserve = event.reserveAfter ?? eventCheckpoint?.replay.state.reserve ?? input.initialReserve;
      const curves = [
        { halfLifeMin: surfaceHalfLifeMin(reserve, input.surfaceHalfLifeMin), shape: surfaceHoldShape },
        { halfLifeMin: input.arousalHalfLifeMin, shape: arousalHoldShape },
      ];
      for (const { halfLifeMin, shape } of curves) {
        const t50Ms = halfLifeMin * 60_000;
        const tau10Ms = t50Ms * (1 / 9) ** (1 / shape);
        for (const time of [event.time + Math.round(tau10Ms), event.time + Math.round(t50Ms)]) {
          if (time >= input.from && time <= input.to) curveTimes.add(time);
        }
      }
    }

    for (const time of [...curveTimes].sort((left, right) => left - right)) {
      if (points.has(time)) continue;
      let checkpoint = checkpoints[0];
      for (const candidate of checkpoints) {
        if (candidate.time > time) break;
        checkpoint = candidate;
      }
      if (!checkpoint) continue;
      const sampleReplay = cloneReplay(checkpoint.replay);
      advanceReplayTo(sampleReplay, time);
      points.set(time, pointAt(time, sampleReplay.state));
    }
  }

  return [...points.values()].sort((left, right) => left.time - right.time);
}
