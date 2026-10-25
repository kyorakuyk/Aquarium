import type { SessionOverride } from '../../../config/schema.ts';
import type { LoadedPersona, PersonaInnerVoiceMode } from '../../../persona/load.ts';

export function resolveInnerVoice(
  sessionOverride: Pick<SessionOverride, 'innerVoice'> | undefined,
  persona: LoadedPersona,
): PersonaInnerVoiceMode {
  return sessionOverride?.innerVoice ?? persona.profile?.speech.innerVoice ?? 'light';
}
