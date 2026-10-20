import type { PromptTemplate } from '../prompt-templates.ts';
import type { PlaceholderValidator } from './reply-system.ts';

export interface MemberSummaryPromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export function parseMemberSummaryTemplate(
  template: PromptTemplate,
  fields: Record<string, unknown>,
  validatePlaceholders: PlaceholderValidator,
): MemberSummaryPromptTemplate {
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('member-summary.md 必须包含非空 system 和 user 文本');
  }
  const memberSummary = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('member-summary.md', memberSummary.system, [], []);
  validatePlaceholders('member-summary.md', memberSummary.user, ['tags'], ['tags']);
  return memberSummary;
}
