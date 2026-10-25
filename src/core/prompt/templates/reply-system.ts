import type { PromptTemplate } from '../templates.ts';

export interface ReplySystemTemplate extends PromptTemplate {
  system: string;
  groupNote: string;
  request: string;
  groupTags: string;
  memberTags: string;
  impressions: string;
  privateFacts: string;
  altRecent: string;
  groupEvents: string;
  knownFacts: string;
  stickers: string;
}

export type PlaceholderValidator = (
  fileName: string,
  source: string,
  allowed: string[],
  required: string[],
) => void;

export function parseReplySystemTemplate(
  template: PromptTemplate,
  fields: Record<string, unknown>,
  validatePlaceholders: PlaceholderValidator,
): ReplySystemTemplate {
  if (typeof fields.system !== 'string' || fields.system.length === 0
    || typeof fields.groupNote !== 'string' || fields.groupNote.length === 0
    || typeof fields.request !== 'string' || fields.request.length === 0
    || typeof fields.groupTags !== 'string' || fields.groupTags.length === 0
    || typeof fields.memberTags !== 'string' || fields.memberTags.length === 0
    || typeof fields.impressions !== 'string' || fields.impressions.length === 0
    || typeof fields.privateFacts !== 'string' || fields.privateFacts.length === 0
    || typeof fields.altRecent !== 'string' || fields.altRecent.length === 0
    || typeof fields.groupEvents !== 'string' || fields.groupEvents.length === 0
    || typeof fields.knownFacts !== 'string' || fields.knownFacts.length === 0
    || typeof fields.stickers !== 'string' || fields.stickers.length === 0) {
    throw new Error('reply-system.md 必须包含非空 system、groupNote、request、groupTags、memberTags、impressions、privateFacts、altRecent、groupEvents、knownFacts 和 stickers 文本');
  }
  const replySystem = {
    ...template,
    system: fields.system,
    groupNote: fields.groupNote,
    request: fields.request,
    groupTags: fields.groupTags,
    memberTags: fields.memberTags,
    impressions: fields.impressions,
    privateFacts: fields.privateFacts,
    altRecent: fields.altRecent,
    groupEvents: fields.groupEvents,
    knownFacts: fields.knownFacts,
    stickers: fields.stickers,
  };
  validatePlaceholders('reply-system.md', replySystem.system, ['ownerRule', 'counterpartRule'], ['ownerRule', 'counterpartRule']);
  validatePlaceholders('reply-system.md', replySystem.groupNote, ['groupNote'], ['groupNote']);
  validatePlaceholders('reply-system.md', replySystem.request, [], []);
  validatePlaceholders('reply-system.md', replySystem.groupTags, ['tags'], ['tags']);
  validatePlaceholders('reply-system.md', replySystem.memberTags, ['name', 'profile', 'tags'], ['name', 'tags']);
  validatePlaceholders('reply-system.md', replySystem.impressions, ['tags'], ['tags']);
  validatePlaceholders('reply-system.md', replySystem.privateFacts, ['name', 'facts'], ['name', 'facts']);
  validatePlaceholders('reply-system.md', replySystem.altRecent, ['messages'], ['messages']);
  validatePlaceholders('reply-system.md', replySystem.groupEvents, ['events'], ['events']);
  validatePlaceholders('reply-system.md', replySystem.knownFacts, ['facts'], ['facts']);
  validatePlaceholders('reply-system.md', replySystem.stickers, ['list'], ['list']);
  return replySystem;
}
