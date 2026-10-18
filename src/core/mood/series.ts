import type { MoodBand, StoredMoodEvent } from '../../store/affect-repo.ts';
import {
  BAND_ORDER,
  MOOD_BAND_BOUNDS,
  SLIDING_FRICTION,
  SLIDING_FRICTION_WINDOW_MS,
  STATIC_FRICTION,
  decayValue,
} from './core.ts';

export const MOOD_SERIES_INTERVAL_MS = 15 * 60_000;

export interface MoodSeriesPoint {
  time: number;
  valence: number;
  arousal: number;
  event: boolean;
}

export interface MoodSeriesAnchor {
  time: number;
  valenceAfter: number | null;
  arousalAfter: number | null;
}

export function buildMoodSeriesPoints(input: {
  from: number;
  to: number;
  halfLifeMin: number;
  baseline: { valence: number; arousal: number };
  previous?: MoodSeriesAnchor;
  events: readonly StoredMoodEvent[];
  intervalMs?: number;
}): MoodSeriesPoint[] {
  const intervalMs = input.intervalMs ?? MOOD_SERIES_INTERVAL_MS;
  if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.to < input.from) {
    throw new RangeError('情绪序列时间范围无效');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('情绪序列间隔必须为正数');
  if (!(input.halfLifeMin > 0)) throw new RangeError('半衰期必须为正数');

  const events = input.events
    .filter((event) => event.time >= input.from && event.time <= input.to)
    .sort((left, right) => left.time - right.time || left.id - right.id);
  const eventTimes = new Set(events.map((event) => event.time));
  const sampleTimes = new Set<number>([input.from, input.to]);
  for (let time = input.from + intervalMs; time < input.to; time += intervalMs) sampleTimes.add(time);
  for (const time of eventTimes) sampleTimes.add(time);

  let anchor: { time: number; valence: number; arousal: number } = input.previous
    && input.previous.time <= input.from
    && input.previous.valenceAfter !== null
    && input.previous.arousalAfter !== null
    ? {
      time: input.previous.time,
      valence: input.previous.valenceAfter,
      arousal: input.previous.arousalAfter,
    }
    : { time: input.from, valence: input.baseline.valence, arousal: input.baseline.arousal };
  let nextAnchor = 0;
  const stateAnchors = events.filter((event) => event.valenceAfter !== null && event.arousalAfter !== null);
  const points: MoodSeriesPoint[] = [];
  for (const time of [...sampleTimes].sort((left, right) => left - right)) {
    while (nextAnchor < stateAnchors.length && (stateAnchors[nextAnchor]?.time ?? Infinity) <= time) {
      const event = stateAnchors[nextAnchor];
      if (event?.valenceAfter !== null && event?.arousalAfter !== null) {
        anchor = { time: event.time, valence: event.valenceAfter, arousal: event.arousalAfter };
      }
      nextAnchor += 1;
    }
    points.push({
      time,
      valence: decayValue(anchor.valence, input.baseline.valence, time - anchor.time, input.halfLifeMin),
      arousal: decayValue(anchor.arousal, input.baseline.arousal, time - anchor.time, input.halfLifeMin),
      event: eventTimes.has(time),
    });
  }
  return points;
}

export interface MoodBandDistance {
  amount: number;
  direction: 'up' | 'down';
  targetBand: MoodBand;
  margin: number;
  friction: 'static' | 'sliding';
}

export function distanceToNextBand(input: {
  band: MoodBand;
  valence: number;
  now: number;
  lastBandChangeAt: number | null;
}): MoodBandDistance {
  const index = BAND_ORDER.indexOf(input.band);
  const sliding = input.lastBandChangeAt !== null
    && input.now - input.lastBandChangeAt < SLIDING_FRICTION_WINDOW_MS;
  const margin = sliding ? SLIDING_FRICTION : STATIC_FRICTION;
  const candidates: MoodBandDistance[] = [];
  if (index < BAND_ORDER.length - 1) {
    candidates.push({
      amount: Math.max(0, (MOOD_BAND_BOUNDS[index] ?? Infinity) + margin - input.valence),
      direction: 'up',
      targetBand: BAND_ORDER[index + 1] ?? input.band,
      margin,
      friction: sliding ? 'sliding' : 'static',
    });
  }
  if (index > 0) {
    candidates.push({
      amount: Math.max(0, input.valence - ((MOOD_BAND_BOUNDS[index - 1] ?? -Infinity) - margin)),
      direction: 'down',
      targetBand: BAND_ORDER[index - 1] ?? input.band,
      margin,
      friction: sliding ? 'sliding' : 'static',
    });
  }
  candidates.sort((left, right) => left.amount - right.amount);
  const nearest = candidates[0];
  if (!nearest) throw new Error('未知情绪档位');
  return nearest;
}
