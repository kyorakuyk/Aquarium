import type { SessionSettings } from '../config/schema.ts';
import type { TraitsPromptTemplate } from '../core/prompt/templates.ts';
import { personaSegmentingLimits, renderPersonaPrompt } from '../persona/injection.ts';
import { loadPersona } from '../persona/load.ts';
import { effectiveTalkLevel, renderTraitsBlock, replyPartLimitForTalk } from '../persona/traits.ts';

export interface SandboxPersonaInput {
  personaId: string;
  nickname: string;
  root: string;
  asOwner: boolean;
  settings: Pick<SessionSettings, 'talkOffset'>;
  traitsTemplate: TraitsPromptTemplate;
  body: { text: string; history: Array<{ text: string }> };
}

export function prepareSandboxPersona(input: SandboxPersonaInput) {
  const persona = loadPersona(input.personaId, input.nickname, { root: input.root });
  const effectiveTalk = effectiveTalkLevel(persona.traits.talk, input.settings.talkOffset);
  const limits = personaSegmentingLimits(persona.profile, {
    maxParts: replyPartLimitForTalk(effectiveTalk),
    maxPartLength: 80,
  });
  return {
    prompt: renderPersonaPrompt(persona, {
      audienceTier: input.asOwner ? 'close' : 'stranger',
      messageText: input.body.text,
      historyText: input.body.history.map((message) => message.text).join('\n'),
    }),
    traitsBlock: renderTraitsBlock(persona.traits, effectiveTalk, input.traitsTemplate),
    ...limits,
  };
}
