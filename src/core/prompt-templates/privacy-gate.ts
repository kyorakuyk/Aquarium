import type { PromptTemplate } from '../prompt-templates.ts';
import type { PlaceholderValidator } from './reply-system.ts';

export interface PrivacyGatePromptTemplate extends PromptTemplate {
  system: string;
  user: string;
}

export function parsePrivacyGateTemplate(
  template: PromptTemplate,
  fields: Record<string, unknown>,
  validatePlaceholders: PlaceholderValidator,
): PrivacyGatePromptTemplate {
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.user !== 'string' || fields.user.length === 0) {
    throw new Error('privacy-gate.md 必须包含非空 system 和 user 文本');
  }
  const privacyGate = { ...template, system: fields.system, user: fields.user };
  validatePlaceholders('privacy-gate.md', privacyGate.system, [], []);
  validatePlaceholders('privacy-gate.md', privacyGate.user, ['context', 'facts'], ['context', 'facts']);
  return privacyGate;
}
