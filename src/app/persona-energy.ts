import type { AquariumConfig } from '../config/schema.ts';
import type { EnergySource } from '../core/mood/core.ts';
import {
  DEFAULT_PERSONA_ENERGY,
  type PersonaEnergyMultipliers,
} from '../persona/energy.ts';
import { loadPersona } from '../persona/load.ts';

export function createPersonaEnergyResolver(getConfig: () => AquariumConfig) {
  function personaIdForAccount(account: number): string {
    return getConfig().accounts.find((entry) => entry.uin === account)?.persona ?? 'default';
  }

  return {
    energySourceForAccount(account: number): EnergySource {
      try {
        return loadPersona(personaIdForAccount(account), '').energySource;
      } catch {
        return 'mixed';
      }
    },
    multipliersForAccount(account: number): PersonaEnergyMultipliers {
      try {
        return loadPersona(personaIdForAccount(account), '').energy;
      } catch {
        return DEFAULT_PERSONA_ENERGY;
      }
    },
  };
}
