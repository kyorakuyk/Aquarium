import type { PromptTemplate } from '../prompt-templates.ts';
import type { PlaceholderValidator } from './reply-system.ts';

export interface ClassifyTagsPromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export function parseClassifyTagsTemplate(
  template: PromptTemplate,
  fields: Record<string, unknown>,
  validatePlaceholders: PlaceholderValidator,
): ClassifyTagsPromptTemplate {
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('classify-tags.md 必须包含非空 system 和 user 文本');
  }
  const classifyTags = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('classify-tags.md', classifyTags.system, [], []);
  validatePlaceholders('classify-tags.md', classifyTags.user, ['scope', 'tags'], ['scope', 'tags']);
  return classifyTags;
}
