import type { AquariumConfig } from '../config/schema.ts';
import { DEFAULT_PERSONA_MOOD, type PersonaMoodSettings } from '../persona/mood.ts';
import { loadPersona } from '../persona/load.ts';

export function createPersonaMoodResolver(getConfig: () => AquariumConfig) {
  function personaIdForAccount(account: number): string {
    return getConfig().accounts.find((entry) => entry.uin === account)?.persona ?? 'default';
  }

  return {
    moodSettingsForAccount(account: number): PersonaMoodSettings {
      try {
        return loadPersona(personaIdForAccount(account), '').mood;
      } catch {
        return DEFAULT_PERSONA_MOOD;
      }
    },
  };
}
