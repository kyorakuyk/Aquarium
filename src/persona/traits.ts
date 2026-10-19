import type { PersonaTraits } from './load.ts';
import type { TraitPromptLevel, TraitsPromptTemplate } from '../core/prompt-templates.ts';

const traitDimensions = ['order', 'morality', 'talk', 'mind', 'humor', 'openness', 'imitation'] as const;

export function effectiveTalkLevel(personaTalk: number, talkOffset: number): number {
  return Math.max(-2, Math.min(2, personaTalk + talkOffset));
}

export function replyPartLimitForTalk(effectiveTalk: number): 1 | 2 | 3 {
  if (effectiveTalk <= -2) return 1;
  if (effectiveTalk === -1) return 2;
  return 3;
}

function levelKey(level: number): TraitPromptLevel | undefined {
  switch (level) {
    case -2: return 'm2';
    case -1: return 'm1';
    case 1: return 'p1';
    case 2: return 'p2';
    default: return undefined;
  }
}

export function renderTraitsBlock(
  traits: PersonaTraits,
  effectiveTalk: number,
  template: TraitsPromptTemplate,
): string {
  return traitDimensions.flatMap((dimension) => {
    const level = dimension === 'talk' ? effectiveTalk : traits[dimension];
    const key = levelKey(level);
    return key ? [template[dimension][key]] : [];
  }).join(' ');
}
