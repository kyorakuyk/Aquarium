import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'yaml';
import { parsePersonaAffinity, type PersonaAffinitySettings } from './affinity.ts';
import { validPersonaId } from './persona-id.ts';

export interface PersonaTraits {
  order: number;
  morality: number;
  talk: number;
  mind: number;
  humor: number;
  openness: number;
  imitation: number;
}

export type PersonaEnergySource = 'inner' | 'outer' | 'mixed';

export type PersonaAudienceTier = 'stranger' | 'acquaintance' | 'close';
export type PersonaSpeechMode = 'normal' | 'restricted';
export type PersonaSegmenting = 'one_message' | 'multi';

export interface PersonaMode {
  name: string;
  trigger: string[];
  behavior: string;
}

export interface PersonaReaction {
  trigger: string;
  response: string;
}

export interface PersonaExample {
  scene: string;
  input: string;
  bad: string;
  good: string;
}

export interface StructuredPersona {
  name: string;
  aliases: string[];
  identity: {
    kind: string;
    selfAwareness: string;
    nameRule: 'self' | 'user-assigned' | 'fixed';
  };
  traits: PersonaTraits;
  energySource: PersonaEnergySource;
  flavor?: Record<string, number>;
  speech: {
    firstPerson: string;
    length: { min: number; max: number };
    segmenting: PersonaSegmenting;
    catchphrases: string[];
    forbidden: string[];
    vocabulary: string[];
  };
  speechMode: PersonaSpeechMode;
  audience?: Partial<Record<PersonaAudienceTier, string>>;
  modes: PersonaMode[];
  reactions: PersonaReaction[];
  reply: { mustReply: string[] };
  boundaries: { hard: string[]; soft: string[] };
  examples: PersonaExample[];
  background: string;
}

export interface LoadedPersona {
  text: string;
  traits: PersonaTraits;
  energySource: PersonaEnergySource;
  affinity: PersonaAffinitySettings;
  profile?: StructuredPersona;
}

export interface LoadPersonaOptions {
  root?: string;
}

const zeroTraits: PersonaTraits = { order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0 };
const traitFields = ['order', 'morality', 'talk', 'mind', 'humor', 'openness', 'imitation'] as const;
const frontmatterPattern = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const traitLevelValues: Record<string, number> = { m2: -2, m1: -1, p1: 1, p2: 2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseYamlHeader(frontmatter: string): Record<string, unknown> {
  let header: unknown;
  try {
    header = yaml.parse(frontmatter);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`人设 YAML 文件头无效：${detail}`);
  }
  if (header === null) return {};
  if (!isRecord(header)) throw new Error('人设 YAML 文件头必须是对象');
  return header;
}

function parseTraits(values: unknown): PersonaTraits {
  if (values !== undefined && (values === null || typeof values !== 'object' || Array.isArray(values))) {
    throw new Error('人设性格字段 traits 必须是对象');
  }
  const input = (values ?? {}) as Record<string, unknown>;
  const traits = {} as PersonaTraits;
  for (const field of traitFields) {
    const value = Object.hasOwn(input, field) ? input[field] : 0;
    const numericValue = typeof value === 'string' ? traitLevelValues[value] : value;
    if (typeof numericValue !== 'number' || !Number.isFinite(numericValue)
      || numericValue < -2 || numericValue > 2
      || Math.abs(numericValue * 10 - Math.round(numericValue * 10)) > 1e-8) {
      throw new Error(`人设性格字段 ${field} 必须是 −2 到 2 之间的数（最多一位小数）或 m2/m1/p1/p2`);
    }
    traits[field] = numericValue;
  }
  return traits;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`结构化人设字段 ${field} 必须是对象`);
  return value;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`结构化人设字段 ${field} 必须是非空文本`);
  }
  return value;
}

function parseStringArray(value: unknown, field: string, optional = false): string[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`结构化人设字段 ${field} 必须是文本数组`);
  }
  return value as string[];
}

function parseModes(value: unknown): PersonaMode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('结构化人设字段 modes 必须是数组');
  return value.map((item, index) => {
    const mode = requiredRecord(item, `modes[${index}]`);
    const trigger = mode.trigger === undefined ? []
      : typeof mode.trigger === 'string' ? [mode.trigger]
        : parseStringArray(mode.trigger, `modes[${index}].trigger`);
    return {
      name: requiredText(mode.name, `modes[${index}].name`),
      trigger,
      behavior: requiredText(mode.behavior, `modes[${index}].behavior`),
    };
  });
}

function parseReactions(value: unknown, field: string): PersonaReaction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`结构化人设字段 ${field} 必须是数组`);
  return value.map((item, index) => {
    const reaction = requiredRecord(item, `${field}[${index}]`);
    return {
      trigger: requiredText(reaction.trigger, `${field}[${index}].trigger`),
      response: requiredText(reaction.response, `${field}[${index}].response`),
    };
  });
}

function parseExamples(value: unknown): PersonaExample[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('结构化人设字段 examples 必须是数组');
  return value.map((item, index) => {
    const example = requiredRecord(item, `examples[${index}]`);
    return {
      scene: requiredText(example.scene, `examples[${index}].scene`),
      input: requiredText(example.input, `examples[${index}].input`),
      bad: requiredText(example.bad, `examples[${index}].bad`),
      good: requiredText(example.good, `examples[${index}].good`),
    };
  });
}

function parseAudience(value: unknown): StructuredPersona['audience'] {
  if (value === undefined) return undefined;
  const audience = requiredRecord(value, 'audience');
  const tiers: PersonaAudienceTier[] = ['stranger', 'acquaintance', 'close'];
  const result: Partial<Record<PersonaAudienceTier, string>> = {};
  for (const tier of tiers) {
    const content = audience[tier];
    if (content !== undefined) result[tier] = requiredText(content, `audience.${tier}`);
  }
  return result;
}

function parseFlavor(value: unknown): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  const flavor = requiredRecord(value, 'traits.flavor');
  const result: Record<string, number> = {};
  for (const [key, weight] of Object.entries(flavor)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new Error(`结构化人设字段 traits.flavor.${key} 必须是非负数字`);
    }
    result[key] = weight;
  }
  return result;
}

function parseEnergySource(value: unknown): PersonaEnergySource {
  const energySource = value ?? 'mixed';
  if (energySource !== 'inner' && energySource !== 'outer' && energySource !== 'mixed') {
    throw new Error('人设字段 energySource 必须是 inner、outer 或 mixed');
  }
  return energySource;
}

function parseStructuredPersona(
  header: Record<string, unknown>,
  text: string,
  traits: PersonaTraits,
  energySource: PersonaEnergySource,
): StructuredPersona | undefined {
  const structuredKeys = [
    'name', 'aliases', 'identity', 'speech', 'speechMode', 'audience', 'modes', 'reactions', 'reply', 'boundaries', 'examples', 'background',
  ];
  if (!structuredKeys.some((key) => Object.hasOwn(header, key))) return undefined;

  const identity = requiredRecord(header.identity, 'identity');
  const speech = requiredRecord(header.speech, 'speech');
  const length = requiredRecord(speech.length, 'speech.length');
  const segmenting = speech.segmenting;
  if (segmenting !== 'one_message' && segmenting !== 'multi') {
    throw new Error('结构化人设字段 speech.segmenting 必须是 one_message 或 multi');
  }
  const minLength = length.min;
  const maxLength = length.max;
  if (!Number.isSafeInteger(minLength) || !Number.isSafeInteger(maxLength)
    || (minLength as number) < 0 || (maxLength as number) < 1 || (minLength as number) > (maxLength as number)) {
    throw new Error('结构化人设字段 speech.length 必须包含合法的 min/max 整数');
  }
  const nameRule = identity.nameRule;
  if (nameRule !== 'self' && nameRule !== 'user-assigned' && nameRule !== 'fixed') {
    throw new Error('结构化人设字段 identity.nameRule 无效');
  }
  const speechMode = header.speechMode ?? 'normal';
  if (speechMode !== 'normal' && speechMode !== 'restricted') {
    throw new Error('结构化人设字段 speechMode 必须是 normal 或 restricted');
  }
  const reply = header.reply === undefined ? {} : requiredRecord(header.reply, 'reply');
  const boundaries = requiredRecord(header.boundaries, 'boundaries');
  const hard = parseStringArray(boundaries.hard, 'boundaries.hard');
  if (hard.length === 0) throw new Error('结构化人设字段 boundaries.hard 至少需要一条');
  const aliases = parseStringArray(header.aliases, 'aliases');

  const vocabulary = parseStringArray(speech.vocabulary, 'speech.vocabulary', true);
  const flavor = parseFlavor(isRecord(header.traits) ? header.traits.flavor : undefined);
  const audience = parseAudience(header.audience);
  return {
    name: requiredText(header.name, 'name'),
    aliases,
    identity: {
      kind: requiredText(identity.kind, 'identity.kind'),
      selfAwareness: requiredText(identity.selfAwareness, 'identity.selfAwareness'),
      nameRule,
    },
    traits,
    energySource,
    ...(flavor === undefined ? {} : { flavor }),
    speech: {
      firstPerson: requiredText(speech.firstPerson, 'speech.firstPerson'),
      length: { min: minLength as number, max: maxLength as number },
      segmenting,
      catchphrases: parseStringArray(speech.catchphrases, 'speech.catchphrases'),
      forbidden: parseStringArray(speech.forbidden, 'speech.forbidden', true),
      vocabulary: vocabulary.length > 0 ? vocabulary : parseStringArray(speech.catchphrases, 'speech.catchphrases'),
    },
    speechMode,
    ...(audience === undefined ? {} : { audience }),
    modes: parseModes(header.modes),
    reactions: [
      ...parseReactions(header.reactions, 'reactions'),
      ...parseReactions(identity.nicknameReactions, 'identity.nicknameReactions'),
    ],
    reply: { mustReply: parseStringArray(reply.mustReply, 'reply.mustReply', true) },
    boundaries: {
      hard,
      soft: parseStringArray(boundaries.soft, 'boundaries.soft', true),
    },
    examples: parseExamples(header.examples),
    background: [typeof header.background === 'string' ? header.background : '', text]
      .filter((part) => part.length > 0)
      .join('\n\n'),
  };
}

export function parsePersonaMarkdown(source: string): LoadedPersona {
  const match = frontmatterPattern.exec(source);
  const header = match ? parseYamlHeader(match[1] ?? '') : {};
  const text = match ? source.slice(match[0].length) : source;
  const traits = match ? parseTraits(header.traits) : { ...zeroTraits };
  const energySource = match ? parseEnergySource(header.energySource) : 'mixed';
  const affinity = parsePersonaAffinity(match ? header.affinity : undefined);
  const profile = match ? parseStructuredPersona(header, text, traits, energySource) : undefined;
  return {
    text,
    traits,
    energySource,
    affinity,
    ...(profile === undefined ? {} : { profile }),
  };
}

export function validatePersonaAffinityFrontmatter(source: string): void {
  const match = frontmatterPattern.exec(source);
  if (!match) return;
  let header: Record<string, unknown>;
  try { header = parseYamlHeader(match[1] ?? ''); }
  catch { return; }
  parsePersonaAffinity(header.affinity);
}

export function updatePersonaTraits(source: string, traits: PersonaTraits): string {
  const match = frontmatterPattern.exec(source);
  let header: Record<string, unknown> = {};
  let text = source;
  if (match) {
    const parsed: unknown = yaml.parse(match[1] ?? '');
    if (parsed === null) header = {};
    else if (typeof parsed === 'object' && !Array.isArray(parsed)) header = parsed as Record<string, unknown>;
    else throw new Error('人设 YAML 文件头必须是对象');
    text = source.slice(match[0].length);
  }
  const updatedHeader = yaml.stringify({ ...header, traits });
  return `---\n${updatedHeader}---\n${text}`;
}

function replaceNameTokens(value: unknown, name: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{{name}}', () => name);
  if (Array.isArray(value)) return value.map((item) => replaceNameTokens(item, name));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceNameTokens(item, name)]));
}

export function loadPersona(
  id: string,
  nickname: string,
  options: LoadPersonaOptions = {},
): LoadedPersona {
  if (!validPersonaId(id.toLowerCase())) throw new Error(`无效的人设 ID：${id}`);
  const root = options.root ?? process.cwd();
  const candidates = [
    join(root, 'data', 'personas', `${id}.md`),
    join(root, 'personas', `${id}.md`),
  ];
  const personaPath = candidates.find(existsSync);
  if (!personaPath) throw new Error(`找不到人设文件：${id}.md`);

  const displayName = nickname.trim() || '水族箱';
  const loaded = parsePersonaMarkdown(readFileSync(personaPath, 'utf8'));
  return {
    text: loaded.text.replaceAll('{{name}}', () => displayName),
    traits: loaded.traits,
    energySource: loaded.energySource,
    affinity: loaded.affinity,
    ...(loaded.profile === undefined
      ? {}
      : { profile: replaceNameTokens(loaded.profile, displayName) as StructuredPersona }),
  };
}
