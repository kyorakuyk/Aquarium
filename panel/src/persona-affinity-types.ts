import type { AffinityCurveSet } from '../../src/core/affinity/curves.ts';

export interface PersonaAffinityPreviewView {
  account: number;
  start: number;
  current: { inherit: number; independent: number };
  tiers: { positive: number[]; negative: number[] };
  curveDefaults: AffinityCurveSet;
}
