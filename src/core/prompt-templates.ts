import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface PromptTemplate {
  source: string;
  version: string;
}

export interface ReplySystemTemplate extends PromptTemplate {
  system: string;
  groupNote: string;
  request: string;
  groupTags: string;
  memberTags: string;
}

export interface VisionPromptTemplate extends PromptTemplate {
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
}

export interface PromptTemplateSet {
  replySystem: ReplySystemTemplate;
  judge: JudgePromptTemplate;
  vision: VisionPromptTemplate;
  appraise: AppraisePromptTemplate;
  affect: AffectPromptTemplate;
  extractTags: ExtractTagsPromptTemplate;
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

function parseReplySystemTemplate(template: PromptTemplate): ReplySystemTemplate {
  const fields = parseTemplateFields(template, 'reply-system.md');
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.groupNote !== 'string' || fields.groupNote.length === 0
    || typeof fields.request !== 'string' || fields.request.length === 0
    || typeof fields.groupTags !== 'string' || fields.groupTags.length === 0
    || typeof fields.memberTags !== 'string' || fields.memberTags.length === 0) {
    throw new Error('reply-system.md 必须包含非空 system、groupNote、request、groupTags 和 memberTags 文本');
  }
  const replySystem = {
    ...template,
    system: fields.system,
    groupNote: fields.groupNote,
    request: fields.request,
    groupTags: fields.groupTags,
    memberTags: fields.memberTags,
  };
  validatePlaceholders('reply-system.md', replySystem.system, ['ownerRule', 'modeHint'], ['ownerRule', 'modeHint']);
  validatePlaceholders('reply-system.md', replySystem.groupNote, ['groupNote'], ['groupNote']);
  validatePlaceholders('reply-system.md', replySystem.request, [], []);
  validatePlaceholders('reply-system.md', replySystem.groupTags, ['tags'], ['tags']);
  validatePlaceholders('reply-system.md', replySystem.memberTags, ['name', 'tags'], ['name', 'tags']);
  return replySystem;
}

function parseVisionTemplate(template: PromptTemplate): VisionPromptTemplate {
  const fields = parseTemplateFields(template, 'vision.md');
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('vision.md 必须包含非空 system 和 user 文本');
  }
  return { ...template, system: fields.system, user: fields.user };
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

function parseAffectTemplate(template: PromptTemplate): AffectPromptTemplate {
  const fields = parseTemplateFields(template, 'affect.md');
  const moodField = fields.mood;
  const floatField = fields.float;
  if (!moodField || typeof moodField !== 'object' || Array.isArray(moodField)
    || !floatField || typeof floatField !== 'object' || Array.isArray(floatField)) {
    throw new Error('affect.md 必须包含 mood 与 float 字段');
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
  const affect = {
    ...template,
    mood,
    float: {
      arousalLow: floatRecord.arousalLow,
      arousalHigh: floatRecord.arousalHigh,
      wrap: floatRecord.wrap,
    },
  };
  validatePlaceholders('affect.md', affect.float.wrap, ['floats'], ['floats']);
  return affect;
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
  const replySystem = parseReplySystemTemplate(readTemplate(root, 'reply-system.md'));
  const judge = parseJudgeTemplate(readTemplate(root, 'judge.md'));
  const vision = parseVisionTemplate(readTemplate(root, 'vision.md'));
  const appraise = parseAppraiseTemplate(readTemplate(root, 'appraise.md'));
  const affect = parseAffectTemplate(readTemplate(root, 'affect.md'));
  const extractTags = parseExtractTagsTemplate(readTemplate(root, 'extract-tags.md'));
  return Object.freeze({
    replySystem: Object.freeze(replySystem),
    judge: Object.freeze(judge),
    vision: Object.freeze(vision),
    appraise: Object.freeze(appraise),
    affect: Object.freeze(affect),
    extractTags: Object.freeze(extractTags),
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
