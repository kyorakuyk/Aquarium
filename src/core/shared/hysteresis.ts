export type HysteresisCause = 'event' | 'decay';

export interface HysteresisState {
  current: number;
  since: number;
  lastChangeAt: number;
}

export interface HysteresisParams {
  bounds: readonly number[];
  staticMargin: number;
  slidingMargin: number;
  slidingWindowMs: number;
  decayDwellMs: number;
}

export function nextLevel(
  state: HysteresisState,
  value: number,
  now: number,
  cause: HysteresisCause,
  params: HysteresisParams,
): number {
  let target = 0;
  for (const bound of params.bounds) {
    if (value < bound) break;
    target += 1;
  }
  if (target === state.current) return state.current;
  if (cause === 'decay' && now - state.since < params.decayDwellMs) return state.current;

  const margin = now - state.lastChangeAt < params.slidingWindowMs
    ? params.slidingMargin
    : params.staticMargin;
  if (target > state.current) {
    const upperBound = params.bounds[state.current];
    return upperBound !== undefined && value >= upperBound + margin ? target : state.current;
  }

  const lowerBound = params.bounds[state.current - 1];
  return lowerBound !== undefined && value < lowerBound - margin ? target : state.current;
}
