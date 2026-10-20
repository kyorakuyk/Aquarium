import type { StoredTag } from '../../store/affect-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import { decide } from '../privacy/policy.ts';
import type { ReplySystemTemplate } from '../prompt/templates.ts';
import { buildMemberTagPrompt } from './member-tags.ts';
import { GROUP_TAGS_LIMIT, selectInjectableTags } from './tags.ts';

interface PromptBlocksInput {
  session: SessionKey;
  sessionId: string;
  senderId: number;
  senderName: string;
  now: number;
  template: ReplySystemTemplate;
}

function displayTagText(tag: Pick<StoredTag, 'category' | 'text'>): string {
  if (tag.category !== 'meme' && tag.category !== 'catchphrase') return tag.text;
  return tag.text.startsWith('「') && tag.text.endsWith('」') ? tag.text : `「${tag.text}」`;
}

export function buildImpressionsPromptBlocks(
  repository: StoreRepository,
  input: PromptBlocksInput,
): { groupTags?: string; memberTags?: string; droppedTags: number } {
  if (input.session.kind !== 'group') return { droppedTags: 0 };
  const account = input.session.account;
  const target = { kind: 'group' as const, sessionId: sessionId(input.session) };
  const groupAllowed = decide({
    info: { origin: 'group', sessionId: input.sessionId, ownerId: null },
    target,
    purpose: 'prompt',
  }) === 'allow';
  const groupSelection = groupAllowed
    ? selectInjectableTags(repository.listTagsForSubject(account, input.sessionId, null), input.now, GROUP_TAGS_LIMIT)
    : { tags: [] as StoredTag[], dropped: 0 };
  const memberAllowed = input.senderId !== account && decide({
    info: { origin: 'group', sessionId: input.sessionId, ownerId: input.senderId },
    target,
    purpose: 'prompt',
  }) === 'allow';
  const memberSelection = !memberAllowed
    ? { text: '', dropped: 0 }
    : buildMemberTagPrompt(repository.listTagsForSubject(account, input.sessionId, input.senderId), input.now);
  const blocks: { groupTags?: string; memberTags?: string; droppedTags: number } = {
    droppedTags: groupSelection.dropped + memberSelection.dropped,
  };
  if (groupSelection.tags.length > 0) {
    blocks.groupTags = input.template.groupTags
      .replaceAll('{{tags}}', groupSelection.tags.map(displayTagText).join('、'));
  }
  if (memberSelection.text.length > 0) {
    blocks.memberTags = input.template.memberTags
      .replaceAll('{{name}}', JSON.stringify(input.senderName))
      .replaceAll('{{tags}}', memberSelection.text);
  }
  return blocks;
}
