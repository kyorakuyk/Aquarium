import type { PersonaTraits } from './load.ts';
import type { TraitPromptLevel, TraitsPromptTemplate } from '../core/prompt/templates.ts';

const traitDimensions = ['order', 'morality', 'talk', 'mind', 'humor', 'openness', 'imitation'] as const;

export function effectiveTalkLevel(personaTalk: number, talkOffset: number): number {
  return Math.max(-2, Math.min(2, personaTalk + talkOffset));
}

export function replyPartLimitForTalk(effectiveTalk: number): 1 | 2 | 3 {
  const level = nearestTraitLevel(effectiveTalk);
  if (level <= -2) return 1;
  if (level === -1) return 2;
  return 3;
}

type TraitModifier = 'slight' | 'strong';

function nearestTraitLevel(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude < 0.25) return 0;
  return Math.sign(value) * Math.max(1, Math.round(magnitude));
}

function levelKey(value: number): TraitPromptLevel | undefined {
  switch (nearestTraitLevel(value)) {
    case -2: return 'm2';
    case -1: return 'm1';
    case 1: return 'p1';
    case 2: return 'p2';
    default: return undefined;
  }
}

function modifierForTrait(value: number): TraitModifier | undefined {
  const magnitude = Math.abs(value);
  if (magnitude < 0.25) return undefined;
  const nearest = Math.round(magnitude);
  if (Math.abs(magnitude - nearest) <= 0.25 + 1e-8) return undefined;
  // 整数档 ±0.25 原样保留；档位间隔前半段用「略」，后半段用「很」。
  const fractionalPart = magnitude - Math.floor(magnitude);
  return fractionalPart < 0.5 ? 'slight' : 'strong';
}

function applyTraitModifier(sentence: string, modifier: TraitModifier | undefined): string {
  if (!modifier) return sentence;
  const subject = sentence.startsWith('你') ? '你' : '';
  const body = sentence.slice(subject.length);
  if (modifier === 'slight') {
    if (body.startsWith('心地好')) return `${subject}有点善良${body.slice('心地好'.length)}`;
    const mildPrefix = /^(?:有点|比较|偏向|偏|挺)/u.exec(body)?.[0];
    if (mildPrefix === '偏向') return `${subject}略微倾向于${body.slice(mildPrefix.length)}`;
    if (mildPrefix) return `${subject}略${body.slice(mildPrefix.length)}`;
    if (/^(?:略|稍微)/u.test(body)) return sentence;
    return `${subject}略${body}`;
  }
  if (/^(?:很|非常|极其)/u.test(body) || /话痨|从不|爱跳话题|刨根问底/u.test(body)) return sentence;
  return `${subject}很${body}`;
}

export function renderTraitsBlock(
  traits: PersonaTraits,
  effectiveTalk: number,
  template: TraitsPromptTemplate,
): string {
  return traitDimensions.flatMap((dimension) => {
    const level = dimension === 'talk' ? effectiveTalk : traits[dimension];
    const key = levelKey(level);
    return key ? [applyTraitModifier(template[dimension][key], modifierForTrait(level))] : [];
  }).join(' ');
}
