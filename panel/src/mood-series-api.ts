import type { MoodBand } from './api.ts';

export interface MoodSeriesPoint {
  time: number;
  valence: number;
  arousal: number;
  reserve: number;
  absorbed: number;
  event: boolean;
}

export interface MoodSeriesView {
  from: number;
  to: number;
  points: MoodSeriesPoint[];
  current: {
    valence: number;
    arousal: number;
    reserve: number;
    reserveBand: 'full' | 'tired' | 'drained';
    reserveBandSince: number | null;
    energySource: 'inner' | 'outer' | 'mixed';
    band: MoodBand;
    bandSince: number | null;
    distanceToNextBand: {
      amount: number;
      direction: 'up' | 'down';
      targetBand: MoodBand;
      margin: number;
      friction: 'static' | 'sliding';
    };
  };
  bandChanges: Array<{ time: number; from: MoodBand; to: MoodBand }>;
  energy: {
    value: number | null;
    status: 'awake' | 'asleep' | 'woken';
    points: Array<{ time: number; value: number | null }>;
  };
  latestReply: {
    id: number;
    blocks: { mood: string | null; reserve: string | null; float: string | null; affinity: string | null };
  } | null;
}
