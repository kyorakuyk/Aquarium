import { loadPersona, type LoadedPersona } from '../../../persona/load.ts';
import { DEFAULT_PERSONA_ENERGY } from '../../../persona/energy.ts';
import type { StepContext } from './types.ts';

export function getPersonaForMessage(ctx: StepContext): LoadedPersona {
  if (ctx.state.persona !== undefined && ctx.state.personaTraits !== undefined) {
    return {
      text: ctx.state.persona,
      traits: ctx.state.personaTraits,
      energySource: ctx.state.personaEnergySource ?? 'mixed',
      energy: ctx.state.personaEnergy ?? DEFAULT_PERSONA_ENERGY,
      affinity: ctx.state.personaAffinity ?? { mode: 'inherit' },
      ...(ctx.state.personaProfile === undefined ? {} : { profile: ctx.state.personaProfile }),
    };
  }

  const config = ctx.state.config ?? ctx.options.getConfig();
  const account = config.accounts.find((entry) => entry.uin === ctx.message.session.account);
  const nickname = ctx.options.getNickname().trim() || String(ctx.message.session.account);
  const loaded = loadPersona(account?.persona ?? 'default', nickname, {
    ...(ctx.options.personaRoot === undefined ? {} : { root: ctx.options.personaRoot }),
  });
  ctx.state.persona = loaded.text;
  ctx.state.personaTraits = loaded.traits;
  ctx.state.personaEnergySource = loaded.energySource;
  ctx.state.personaEnergy = loaded.energy;
  ctx.state.personaAffinity = loaded.affinity;
  if (loaded.profile === undefined) delete ctx.state.personaProfile;
  else ctx.state.personaProfile = loaded.profile;
  return loaded;
}
