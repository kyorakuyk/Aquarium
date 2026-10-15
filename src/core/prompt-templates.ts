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
}

export interface VisionPromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export interface PromptTemplateSet {
  replySystem: ReplySystemTemplate;
  vision: VisionPromptTemplate;
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
    || typeof fields.request !== 'string' || fields.request.length === 0) {
    throw new Error('reply-system.md 必须包含非空 system、groupNote 和 request 文本');
  }
  const replySystem = {
    ...template,
    system: fields.system,
    groupNote: fields.groupNote,
    request: fields.request,
  };
  validatePlaceholders('reply-system.md', replySystem.system, ['ownerRule', 'modeHint'], ['ownerRule', 'modeHint']);
  validatePlaceholders('reply-system.md', replySystem.groupNote, ['groupNote'], ['groupNote']);
  validatePlaceholders('reply-system.md', replySystem.request, [], []);
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
  const vision = parseVisionTemplate(readTemplate(root, 'vision.md'));
  return Object.freeze({
    replySystem: Object.freeze(replySystem),
    vision: Object.freeze(vision),
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
