import type { AquariumConfig } from '../../config/schema.ts';
import type { PersonaMoodSettings } from '../../persona/mood.ts';

export function resolveMoodSettings(
  global: AquariumConfig['mood'],
  persona?: Pick<PersonaMoodSettings, 'surfaceHoldShape' | 'arousalHoldShape'> | null,
): AquariumConfig['mood'] {
  return {
    ...global,
    surfaceHoldShape: persona?.surfaceHoldShape ?? global.surfaceHoldShape,
    arousalHoldShape: persona?.arousalHoldShape ?? global.arousalHoldShape,
  };
}
