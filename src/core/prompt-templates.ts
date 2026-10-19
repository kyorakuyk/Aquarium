import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseReplySystemTemplate, type ReplySystemTemplate } from './prompt-templates/reply-system.ts';
import { parsePrivacyGateTemplate, type PrivacyGatePromptTemplate } from './prompt-templates/privacy-gate.ts';
import { parsePrivacyMentionTemplate, type PrivacyMentionPromptTemplate } from './prompt-templates/privacy-mention.ts';

export type { ReplySystemTemplate } from './prompt-templates/reply-system.ts';
export type { PrivacyGatePromptTemplate } from './prompt-templates/privacy-gate.ts';
export type { PrivacyMentionPromptTemplate } from './prompt-templates/privacy-mention.ts';

export interface PromptTemplate {
  source: string;
  version: string;
}

export interface VisionPromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export interface StickerDescribePromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export interface JudgePromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export interface AppraisePromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export interface ExtractTagsPromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export interface ExtractPrivatePromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export interface PersonaImportPromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export interface AffectPromptTemplate extends PromptTemplate {
  mood: {
    low: string;
    annoyed: string;
    calm: string;
    happy: string;
    excited: string;
  };
  float: {
    arousalLow: string;
    arousalHigh: string;
    wrap: string;
  };
  affinity: {
    cold: string;
    cool: string;
    warm: string;
    close: string;
  };
}

export type TraitPromptLevel = 'm2' | 'm1' | 'p1' | 'p2';

export interface TraitsPromptTemplate extends PromptTemplate {
  order: Record<TraitPromptLevel, string>;
  morality: Record<TraitPromptLevel, string>;
  talk: Record<TraitPromptLevel, string>;
  mind: Record<TraitPromptLevel, string>;
  humor: Record<TraitPromptLevel, string>;
  openness: Record<TraitPromptLevel, string>;
  imitation: Record<TraitPromptLevel, string>;
}

export interface SleepPromptTemplate extends PromptTemplate {
  goodnight: readonly string[];
}

export interface PromptTemplateSet {
  replySystem: ReplySystemTemplate;
  judge: JudgePromptTemplate;
  vision: VisionPromptTemplate;
  stickerDescribe: StickerDescribePromptTemplate;
  appraise: AppraisePromptTemplate;
  affect: AffectPromptTemplate;
  traits: TraitsPromptTemplate;
  sleep: SleepPromptTemplate;
  extractTags: ExtractTagsPromptTemplate;
  extractPrivate: ExtractPrivatePromptTemplate;
  privacyGate: PrivacyGatePromptTemplate;
  privacyMention: PrivacyMentionPromptTemplate;
  personaImport: PersonaImportPromptTemplate;
}

export interface PromptTemplateStore {
  get(): PromptTemplateSet;
  reload(): PromptTemplateSet;
}

export interface ConfigChangeSource {
  on(event: 'changed', listener: () => void): unknown;
  off(event: 'changed', listener: () => void): unknown;
}

function normalizeTemplate(source: string): string {
  return source.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').replace(/\n$/u, '');
}

function readTemplate(root: string, fileName: string): PromptTemplate {
  const bytes = fs.readFileSync(path.join(root, fileName));
  const source = normalizeTemplate(bytes.toString('utf8'));
  if (source.length === 0) throw new Error(`提示词模板不能为空：${fileName}`);
  return {
    source,
    version: createHash('sha256').update(bytes).digest('hex').slice(0, 8),
  };
}

function parseTemplateFields(template: PromptTemplate, fileName: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---$/u.exec(template.source);
  if (!match?.[1]) throw new Error(`${fileName} 必须包含 YAML front matter`);
  const parsed: unknown = parseYaml(match[1]);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fileName} 必须包含有效的 YAML 字段`);
  }
  return parsed as Record<string, unknown>;
}

function parseVisionTemplate(template: PromptTemplate): VisionPromptTemplate {
  const fields = parseTemplateFields(template, 'vision.md');
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('vision.md 必须包含非空 system 和 user 文本');
  }
  return { ...template, system: fields.system, user: fields.user };
}

function parseStickerDescribeTemplate(template: PromptTemplate): StickerDescribePromptTemplate {
  const fields = parseTemplateFields(template, 'sticker-describe.md');
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('sticker-describe.md 必须包含非空 system 和 user 文本');
  }
  const stickerDescribe = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('sticker-describe.md', stickerDescribe.system, [], []);
  validatePlaceholders('sticker-describe.md', stickerDescribe.user, [], []);
  return stickerDescribe;
}

function parseJudgeTemplate(template: PromptTemplate): JudgePromptTemplate {
  const fields = parseTemplateFields(template, 'judge.md');
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('judge.md 必须包含非空 system 和 user 文本');
  }
  const judge = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('judge.md', judge.system, [], []);
  validatePlaceholders('judge.md', judge.user, ['context'], ['context']);
  return judge;
}

function parseAppraiseTemplate(template: PromptTemplate): AppraisePromptTemplate {
  const fields = parseTemplateFields(template, 'appraise.md');
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('appraise.md 必须包含非空 system 和 user 文本');
  }
  const appraise = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('appraise.md', appraise.system, [], []);
  validatePlaceholders('appraise.md', appraise.user, ['context'], ['context']);
  return appraise;
}

const affectMoodKeys = ['low', 'annoyed', 'calm', 'happy', 'excited'] as const;
const traitPromptLevels = ['m2', 'm1', 'p1', 'p2'] as const;

function parseAffectTemplate(template: PromptTemplate): AffectPromptTemplate {
  const fields = parseTemplateFields(template, 'affect.md');
  const moodField = fields.mood;
  const floatField = fields.float;
  const affinityField = fields.affinity;
  if (!moodField || typeof moodField !== 'object' || Array.isArray(moodField)
    || !floatField || typeof floatField !== 'object' || Array.isArray(floatField)
    || !affinityField || typeof affinityField !== 'object' || Array.isArray(affinityField)) {
    throw new Error('affect.md 必须包含 mood、float 与 affinity 字段');
  }
  const moodRecord = moodField as Record<string, unknown>;
  const mood = {} as AffectPromptTemplate['mood'];
  for (const key of affectMoodKeys) {
    const value = moodRecord[key];
    if (typeof value !== 'string') throw new Error(`affect.md 缺少 mood.${key} 文本`);
    mood[key] = value;
  }
  const floatRecord = floatField as Record<string, unknown>;
  if (typeof floatRecord.arousalLow !== 'string' || typeof floatRecord.arousalHigh !== 'string'
    || typeof floatRecord.wrap !== 'string') {
    throw new Error('affect.md 必须包含 float.arousalLow、float.arousalHigh 与 float.wrap 文本');
  }
  const affinityRecord = affinityField as Record<string, unknown>;
  const affinity = {} as AffectPromptTemplate['affinity'];
  for (const key of ['cold', 'cool', 'warm', 'close'] as const) {
    const value = affinityRecord[key];
    if (typeof value !== 'string') throw new Error(`affect.md 缺少 affinity.${key} 文本`);
    affinity[key] = value;
    validatePlaceholders('affect.md', value, ['name'], ['name']);
  }
  const affect = {
    ...template,
    mood,
    float: {
      arousalLow: floatRecord.arousalLow,
      arousalHigh: floatRecord.arousalHigh,
      wrap: floatRecord.wrap,
    },
    affinity,
  };
  validatePlaceholders('affect.md', affect.float.wrap, ['floats'], ['floats']);
  return affect;
}

function parseTraitsTemplate(template: PromptTemplate): TraitsPromptTemplate {
  const fields = parseTemplateFields(template, 'traits.md');
  const parsed = {} as Pick<TraitsPromptTemplate, 'order' | 'morality' | 'talk' | 'mind' | 'humor' | 'openness' | 'imitation'>;
  for (const dimension of ['order', 'morality', 'talk', 'mind', 'humor', 'openness', 'imitation'] as const) {
    const field = fields[dimension];
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error(`traits.md 必须包含 ${dimension} 档位文本`);
    }
    const values = field as Record<string, unknown>;
    const levels = {} as Record<TraitPromptLevel, string>;
    for (const level of traitPromptLevels) {
      const value = values[level];
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`traits.md 缺少 ${dimension}.${level} 文本`);
      }
      levels[level] = value;
    }
    parsed[dimension] = levels;
  }
  return { ...template, ...parsed };
}

function parseSleepTemplate(template: PromptTemplate): SleepPromptTemplate {
  const fields = parseTemplateFields(template, 'sleep.md');
  if (!Array.isArray(fields.goodnight) || fields.goodnight.length === 0
    || fields.goodnight.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error('sleep.md 必须包含非空 goodnight 文本列表');
  }
  return { ...template, goodnight: fields.goodnight as string[] };
}

function parseExtractTagsTemplate(template: PromptTemplate): ExtractTagsPromptTemplate {
  const fields = parseTemplateFields(template, 'extract-tags.md');
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('extract-tags.md 必须包含非空 system 和 user 文本');
  }
  const extractTags = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('extract-tags.md', extractTags.system, [], []);
  validatePlaceholders('extract-tags.md', extractTags.user, ['context', 'existing'], ['context', 'existing']);
  return extractTags;
}

function parseExtractPrivateTemplate(template: PromptTemplate): ExtractPrivatePromptTemplate {
  const fields = parseTemplateFields(template, 'extract-private.md');
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('extract-private.md 必须包含非空 system 和 user 文本');
  }
  const extractPrivate = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('extract-private.md', extractPrivate.system, [], []);
  validatePlaceholders('extract-private.md', extractPrivate.user, ['context', 'existing'], ['context', 'existing']);
  return extractPrivate;
}

function parsePersonaImportTemplate(template: PromptTemplate): PersonaImportPromptTemplate {
  const fields = parseTemplateFields(template, 'persona-import.md');
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('persona-import.md 必须包含非空 system 和 user 文本');
  }
  const personaImport = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('persona-import.md', personaImport.system, [], []);
  validatePlaceholders('persona-import.md', personaImport.user, ['text'], ['text']);
  return personaImport;
}

function validatePlaceholders(
  fileName: string,
  source: string,
  allowed: string[],
  required: string[],
): void {
  const found = new Set<string>();
  for (const match of source.matchAll(/\{\{([^{}]+)\}\}/gu)) {
    const name = match[1] ?? '';
    if (!allowed.includes(name)) throw new Error(`${fileName} 包含未知占位符：${name}`);
    found.add(name);
  }
  for (const name of required) {
    if (!found.has(name)) throw new Error(`${fileName} 缺少占位符 {{${name}}}`);
  }
}

function readPromptTemplateSet(root: string): PromptTemplateSet {
  const replySystemSource = readTemplate(root, 'reply-system.md');
  const replySystem = parseReplySystemTemplate(
    replySystemSource,
    parseTemplateFields(replySystemSource, 'reply-system.md'),
    validatePlaceholders,
  );
  const judge = parseJudgeTemplate(readTemplate(root, 'judge.md'));
  const vision = parseVisionTemplate(readTemplate(root, 'vision.md'));
  const stickerDescribe = parseStickerDescribeTemplate(readTemplate(root, 'sticker-describe.md'));
  const appraise = parseAppraiseTemplate(readTemplate(root, 'appraise.md'));
  const affect = parseAffectTemplate(readTemplate(root, 'affect.md'));
  const traits = parseTraitsTemplate(readTemplate(root, 'traits.md'));
  const sleep = parseSleepTemplate(readTemplate(root, 'sleep.md'));
  const extractTags = parseExtractTagsTemplate(readTemplate(root, 'extract-tags.md'));
  const extractPrivate = parseExtractPrivateTemplate(readTemplate(root, 'extract-private.md'));
  const privacyGateSource = readTemplate(root, 'privacy-gate.md');
  const privacyGate = parsePrivacyGateTemplate(
    privacyGateSource,
    parseTemplateFields(privacyGateSource, 'privacy-gate.md'),
    validatePlaceholders,
  );
  const privacyMentionSource = readTemplate(root, 'privacy-mention.md');
  const privacyMention = parsePrivacyMentionTemplate(
    privacyMentionSource,
    parseTemplateFields(privacyMentionSource, 'privacy-mention.md'),
    validatePlaceholders,
  );
  const personaImport = parsePersonaImportTemplate(readTemplate(root, 'persona-import.md'));
  return Object.freeze({
    replySystem: Object.freeze(replySystem),
    judge: Object.freeze(judge),
    vision: Object.freeze(vision),
    stickerDescribe: Object.freeze(stickerDescribe),
    appraise: Object.freeze(appraise),
    affect: Object.freeze(affect),
    traits: Object.freeze(traits),
    sleep: Object.freeze({ ...sleep, goodnight: Object.freeze(sleep.goodnight) }),
    extractTags: Object.freeze(extractTags),
    extractPrivate: Object.freeze(extractPrivate),
    privacyGate: Object.freeze(privacyGate),
    privacyMention: Object.freeze(privacyMention),
    personaImport: Object.freeze(personaImport),
  });
}

export function createPromptTemplateStore(root = path.join(process.cwd(), 'prompts')): PromptTemplateStore {
  let current = readPromptTemplateSet(root);
  return {
    get: () => current,
    reload: () => {
      const next = readPromptTemplateSet(root);
      current = next;
      return current;
    },
  };
}

export function bindPromptTemplateReload(
  source: ConfigChangeSource,
  store: PromptTemplateStore,
  onError: (error: unknown) => void,
): () => void {
  const listener = () => {
    try {
      store.reload();
    } catch (error) {
      onError(error);
    }
  };
  source.on('changed', listener);
  return () => source.off('changed', listener);
}

export const promptTemplateStore = createPromptTemplateStore();
