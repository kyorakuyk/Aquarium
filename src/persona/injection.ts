import type {
  LoadedPersona,
  PersonaAudienceTier,
  PersonaExample,
  PersonaMode,
  PersonaReaction,
  StructuredPersona,
} from './load.ts';

export interface PersonaPromptContext {
  audienceTier?: PersonaAudienceTier;
  messageText?: string;
  historyText?: string;
  exampleTopK?: number;
}

interface PersonaPromptBlock {
  id: string;
  text: string;
}

export interface PersonaSegmentingLimits {
  maxParts: 1 | 2 | 3;
  maxPartLength: number;
}

const blockBudgets = {
  identity: 900,
  boundaries: 1_200,
  speech: 1_500,
  audience: 350,
  mode: 450,
  reaction: 250,
  examples: 850,
  background: 450,
} as const;

function truncateCharacters(text: string, limit: number): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  if (limit <= 0) return '';
  return `${characters.slice(0, limit - 1).join('')}…`;
}

function normalizedText(text: string): string {
  return text.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function triggerText(trigger: string): string {
  return normalizedText(trigger
    .replace(/^(?:被叫|被叫做|被称为|叫作)/u, '')
    .replace(/["'“”「」『』]/gu, ''));
}

function modeMatches(mode: PersonaMode, message: string): { matched: boolean; length: number } {
  const candidates = mode.trigger.filter((trigger) => trigger.trim() !== '' && trigger.trim() !== '默认');
  const matched = candidates
    .map((trigger) => triggerText(trigger))
    .filter((trigger) => trigger.length > 0 && message.includes(trigger))
    .sort((left, right) => right.length - left.length)[0];
  return { matched: matched !== undefined, length: matched?.length ?? 0 };
}

function selectMode(modes: readonly PersonaMode[], message: string): PersonaMode | undefined {
  const matching = modes
    .map((mode, index) => ({ mode, index, result: modeMatches(mode, message) }))
    .filter((entry) => entry.result.matched)
    .sort((left, right) => right.result.length - left.result.length || left.index - right.index)[0];
  if (matching) return matching.mode;
  return modes.find((mode) => mode.trigger.some((trigger) => trigger.trim() === '默认'));
}

function selectReaction(reactions: readonly PersonaReaction[], message: string): PersonaReaction | undefined {
  return reactions
    .map((reaction, index) => ({ reaction, index, trigger: triggerText(reaction.trigger) }))
    .filter((entry) => entry.trigger.length > 0 && message.includes(entry.trigger))
    .sort((left, right) => right.trigger.length - left.trigger.length || left.index - right.index)[0]?.reaction;
}

function exampleScore(example: PersonaExample, message: string): number {
  const input = normalizedText(example.input);
  const scene = normalizedText(example.scene);
  if (input && message.includes(input)) return 100 + input.length;
  if (scene && message.includes(scene)) return 50 + scene.length;
  return 0;
}

function selectExamples(
  examples: readonly PersonaExample[],
  message: string,
  topK: number,
): PersonaExample[] {
  if (topK <= 0 || message.length === 0) return [];
  return examples
    .map((example, index) => ({ example, index, score: exampleScore(example, message) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.min(topK, 5))
    .map(({ example }) => example);
}

function backgroundSections(background: string): string[] {
  const source = background.trim();
  if (!source) return [];
  const headings = source.split(/(?=^#{1,6}[ \t]+[^\r\n]+\s*$)/mu)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
  const sections = headings.length > 1
    ? headings
    : source.split(/\r?\n[ \t]*\r?\n/u).map((section) => section.trim()).filter(Boolean);
  return sections.slice(0, 3).map((section) => truncateCharacters(section, 150));
}

function addBlock(blocks: PersonaPromptBlock[], id: string, text: string, budget: number): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  blocks.push({ id, text: truncateCharacters(trimmed, budget) });
}

function identityBlock(profile: StructuredPersona): string {
  const lines = [
    `# ${profile.name}`,
    `身份：${profile.identity.kind}`,
    `自我认知：${profile.identity.selfAwareness}`,
    `名字规则：${profile.identity.nameRule}`,
  ];
  if (profile.aliases.length > 0) lines.push(`称呼：${profile.aliases.join('、')}`);
  return lines.join('\n');
}

function speechBlock(profile: StructuredPersona): string {
  if (profile.speechMode === 'restricted') {
    return profile.speech.vocabulary.length > 0
      ? `词表：${profile.speech.vocabulary.join('、')}`
      : '';
  }
  const lines = [
    `第一人称：${profile.speech.firstPerson}`,
    `每条长度：${profile.speech.length.min}–${profile.speech.length.max} 字。`,
    profile.speech.segmenting === 'one_message'
      ? '回复合并为一条消息。'
      : '允许按语义分成多条消息。',
  ];
  if (profile.speech.catchphrases.length > 0) lines.push(`口头禅：${profile.speech.catchphrases.join('、')}`);
  if (profile.speech.forbidden.length > 0) lines.push(`避免：${profile.speech.forbidden.join('、')}`);
  return lines.join('\n');
}

function renderBlocks(profile: StructuredPersona, context: PersonaPromptContext): PersonaPromptBlock[] {
  const message = normalizedText(context.messageText ?? '');
  const conversation = normalizedText([context.messageText ?? '', context.historyText ?? ''].join('\n'));
  const blocks: PersonaPromptBlock[] = [];
  addBlock(blocks, 'identity', identityBlock(profile), blockBudgets.identity);
  addBlock(
    blocks,
    'boundaries-hard',
    `底线：\n${profile.boundaries.hard.map((item) => `- ${item}`).join('\n')}`,
    blockBudgets.boundaries,
  );
  addBlock(blocks, 'speech', speechBlock(profile), blockBudgets.speech);

  const audienceText = context.audienceTier === undefined ? undefined : profile.audience?.[context.audienceTier];
  if (audienceText) addBlock(blocks, `audience-${context.audienceTier}`, `对${context.audienceTier}：${audienceText}`, blockBudgets.audience);

  const mode = selectMode(profile.modes, conversation);
  if (mode) addBlock(blocks, `mode-${mode.name}`, `当前模式（${mode.name}）：${mode.behavior}`, blockBudgets.mode);

  const reaction = selectReaction(profile.reactions, message);
  if (reaction) addBlock(blocks, 'reaction', `命中反应：${reaction.response}`, blockBudgets.reaction);

  const topK = context.exampleTopK ?? 2;
  const examples = selectExamples(profile.examples, conversation, topK);
  if (examples.length > 0) {
    addBlock(blocks, 'examples', examples.map((example) => [
      `场景：${example.scene}`,
      `输入：${example.input}`,
      `反例：${example.bad}`,
      `示例：${example.good}`,
    ].join('\n')).join('\n\n'), blockBudgets.examples);
  }

  const sections = backgroundSections(profile.background);
  if (sections.length > 0) addBlock(blocks, 'background', `背景：\n${sections.join('\n\n')}`, blockBudgets.background);
  return blocks;
}

export function personaAudienceTierFromAffinity(level: string | undefined): PersonaAudienceTier | undefined {
  if (level === 'enemy' || level === 'loathe' || level === 'dislike'
    || level === 'uncomfortable' || level === 'distant' || level === 'unfamiliar') return 'stranger';
  if (level === 'acquaintance' || level === 'ordinary_friend') return 'acquaintance';
  if (level === 'more_than_friends' || level === 'lover') return 'close';
  return undefined;
}

export function matchesPersonaMustReply(
  profile: StructuredPersona | undefined,
  input: { plainText: string; mentionsSelf: boolean },
): boolean {
  if (!profile) return false;
  const message = normalizedText(input.plainText);
  return profile.reply.mustReply.some((trigger) => {
    const value = trigger.trim();
    if (value.includes('@') || value === '被叫') return input.mentionsSelf;
    const normalized = normalizedText(value);
    return normalized.length > 0 && message.includes(normalized);
  });
}

export function personaSegmentingLimits(
  profile: StructuredPersona | undefined,
  legacy: PersonaSegmentingLimits,
): PersonaSegmentingLimits {
  if (!profile) return legacy;
  return {
    maxParts: profile.speech.segmenting === 'one_message' ? 1 : 3,
    maxPartLength: profile.speech.length.max,
  };
}

export function renderPersonaPrompt(persona: LoadedPersona, context: PersonaPromptContext = {}): string {
  if (!persona.profile) return persona.text;
  return renderBlocks(persona.profile, context).map((block) => block.text).join('\n\n');
}
