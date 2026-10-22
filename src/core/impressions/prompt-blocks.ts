import type { StoredTag } from '../../store/affect-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import { createQqProfileService } from '../profiles/qq-profile-service.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import { decide } from '../privacy/policy.ts';
import type { ReplySystemTemplate } from '../prompt/templates.ts';
import { buildMemberTagPrompt } from './member-tags.ts';
import { GROUP_TAGS_LIMIT, selectInjectableTags, type TagPromptStateUpdate } from './tags.ts';
import { redactSensitiveText } from './sensitive-text.ts';
import { accountUserName, resolveAccountIdentity } from '../profiles/account-identity.ts';

const RELATION_LABELS = {
  lover: '恋人',
  brother: '兄弟',
  sister: '姐妹',
  roommate: '室友',
  enemy: '敌人',
} as const;

const MAX_RELATION_LINES = 5;
const MAX_RELATION_CHARACTERS = 180;

export function relationPromptLines(
  repository: StoreRepository,
  account: number,
  sessionId: string,
  userId: number,
): string[] {
  const lines = repository.listRelationsForUser(account, userId).flatMap((relation) => {
    if (relation.locked) return [];
    const isMain = relation.aUserId === userId;
    const otherUserId = isMain ? relation.bUserId : relation.aUserId;
    const displayUserId = relation.type === 'alt'
      ? otherUserId
      : repository.mainUserIdFor(account, otherUserId);
    if (displayUserId === userId && relation.type !== 'alt') return [];
    const name = accountUserName(repository, account, sessionId, displayUserId);
    if (relation.type === 'alt') {
      return [isMain ? `拥有小号 ${JSON.stringify(name)}` : `是 ${JSON.stringify(name)} 的小号`];
    }
    const label = relation.type === 'other'
      ? JSON.stringify(redactSensitiveText(relation.label?.trim() ?? '关系'))
      : RELATION_LABELS[relation.type];
    return [`和${JSON.stringify(name)}是${label}`];
  });
  const selected: string[] = [];
  let characters = 0;
  for (const line of lines) {
    const length = Array.from(line).length;
    if (selected.length >= MAX_RELATION_LINES) break;
    if (characters + length > MAX_RELATION_CHARACTERS) continue;
    selected.push(line);
    characters += length;
  }
  return selected;
}

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
  onTagPromptStates?: (updates: readonly TagPromptStateUpdate[]) => void,
): { groupTags?: string; memberTags?: string; droppedTags: number } {
  if (input.session.kind !== 'group') return { droppedTags: 0 };
  const account = input.session.account;
  const identity = resolveAccountIdentity(repository, {
    account,
    sessionId: input.sessionId,
    userId: input.senderId,
    fallbackName: input.senderName,
  });
  const qqProfiles = createQqProfileService({ repository, now: () => input.now });
  const target = { kind: 'group' as const, sessionId: sessionId(input.session) };
  const groupAllowed = decide({
    info: { origin: 'group', sessionId: input.sessionId, ownerId: null },
    target,
    purpose: 'prompt',
  }) === 'allow';
  const groupSelection = groupAllowed
    ? selectInjectableTags(repository.listTagsForSubject(account, input.sessionId, null)
      .filter((tag) => tag.kind === 'fact'), input.now, GROUP_TAGS_LIMIT, {
        renderText: (tags) => tags.map(displayTagText).join('、'),
      })
    : { tags: [] as StoredTag[], dropped: 0, stateUpdates: [] };
  const memberAllowed = identity.userId !== account && decide({
    info: { origin: 'group', sessionId: input.sessionId, ownerId: identity.userId },
    target,
    purpose: 'prompt',
  }) === 'allow';
  const memberSelection = !memberAllowed
    ? { text: '', dropped: 0, profileText: '', stateUpdates: [] }
    : buildMemberTagPrompt(
      repository.listTagsForSubject(account, input.sessionId, identity.userId)
        .filter((tag) => tag.kind === 'fact'),
      input.now,
      {
        ...qqProfiles.getCachedMemberProfile(account, input.session.peer, identity.userId),
        relationships: relationPromptLines(repository, account, input.sessionId, identity.userId),
      },
    );
  onTagPromptStates?.([...groupSelection.stateUpdates, ...memberSelection.stateUpdates]);
  const blocks: { groupTags?: string; memberTags?: string; droppedTags: number } = {
    droppedTags: groupSelection.dropped + memberSelection.dropped,
  };
  if (groupSelection.tags.length > 0) {
    blocks.groupTags = input.template.groupTags
      .replaceAll('{{tags}}', groupSelection.tags.map(displayTagText).join('、'));
  }
  if (memberSelection.text.length > 0 || memberSelection.profileText.length > 0 || identity.kind === 'bot') {
    blocks.memberTags = input.template.memberTags
      .replaceAll('{{name}}', JSON.stringify(identity.kind === 'bot' ? `${identity.name}（bot）` : identity.name))
      .replaceAll('{{profile}}', memberSelection.profileText)
      .replaceAll('{{tags}}', memberSelection.text || '暂无已确认标签');
  }
  return blocks;
}
