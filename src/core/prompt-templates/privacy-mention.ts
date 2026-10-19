import type { PromptTemplate } from '../prompt-templates.ts';
import type { PlaceholderValidator } from './reply-system.ts';

export interface PrivacyMentionPromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export function parsePrivacyMentionTemplate(
  template: PromptTemplate,
  fields: Record<string, unknown>,
  validatePlaceholders: PlaceholderValidator,
): PrivacyMentionPromptTemplate {
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('privacy-mention.md 必须包含非空 system 和 user 文本');
  }
  const privacyMention = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('privacy-mention.md', privacyMention.system, [], []);
  validatePlaceholders('privacy-mention.md', privacyMention.user, ['message', 'facts'], ['message', 'facts']);
  return privacyMention;
}
