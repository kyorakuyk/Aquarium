import type { MoodEventRecord } from '../../store/affect-repo.ts';
import { reanchor } from './core.ts';
import type { ResolvedMoodState } from './state.ts';

export interface MoodHoldShapes {
  surfaceHoldShape: number;
  arousalHoldShape: number;
}

export function reanchorMoodValues(
  current: Pick<ResolvedMoodState,
    'valence' | 'arousal' | 'dominance' | 'valenceU' | 'arousalU' | 'dominanceU'>,
  next: { valence: number; arousal: number; dominance: number },
  baseline: { valence: number; arousal: number },
  shapes: MoodHoldShapes,
): Pick<ResolvedMoodState,
  'valence' | 'arousal' | 'dominance' | 'valenceD0' | 'valenceU' | 'arousalD0' | 'arousalU' | 'dominanceD0' | 'dominanceU'> {
  const valenceAnchor = reanchor(
    current.valence - baseline.valence,
    next.valence - baseline.valence,
    current.valenceU,
    shapes.surfaceHoldShape,
  );
  const arousalAnchor = reanchor(
    current.arousal - baseline.arousal,
    next.arousal - baseline.arousal,
    current.arousalU,
    shapes.arousalHoldShape,
  );
  const dominanceAnchor = reanchor(
    current.dominance,
    next.dominance,
    current.dominanceU,
    shapes.arousalHoldShape,
  );
  return {
    ...next,
    valenceD0: valenceAnchor.d0,
    valenceU: valenceAnchor.u,
    arousalD0: arousalAnchor.d0,
    arousalU: arousalAnchor.u,
    dominanceD0: dominanceAnchor.d0,
    dominanceU: dominanceAnchor.u,
  };
}

export function eventAnchorFields(state: Pick<ResolvedMoodState, 'valenceU' | 'arousalU' | 'dominanceU'>): Pick<
  MoodEventRecord,
  'valenceUAfter' | 'arousalUAfter' | 'dominanceUAfter'
> {
  return {
    valenceUAfter: state.valenceU,
    arousalUAfter: state.arousalU,
    dominanceUAfter: state.dominanceU,
  };
}
