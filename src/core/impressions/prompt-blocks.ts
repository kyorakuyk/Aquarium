import type { StoredTag } from '../../store/affect-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import { createQqProfileService } from '../profiles/qq-profile-service.ts';
import { parseSessionId } from '../conversation/sessions.ts';
import type { SessionKey } from '../shared/events.ts';
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
const VIEW_TAGS_LIMIT = { max: 4, maxChars: 100 } as const;

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

function displayViewTagText(tag: StoredTag): string {
  const text = redactSensitiveText(tag.text);
  return tag.certain || text.endsWith('?') ? text : `${text}?`;
}

function viewTagAllowed(
  tag: StoredTag,
  account: number,
  subjectId: number | null,
  target: { kind: 'group'; sessionId: string } | { kind: 'private'; sessionId: string; peerId: number },
): boolean {
  if (tag.kind !== 'view' || (tag.userId !== null && tag.userId !== subjectId)) return false;
  const source = parseSessionId(tag.sessionId);
  if (!source || source.account !== account) return false;
  const decision = decide({
    info: {
      origin: source.kind,
      sessionId: tag.sessionId,
      ownerId: tag.userId,
      ...(source.kind === 'private' ? { level: 'L0' as const } : {}),
    },
    target,
    purpose: 'prompt',
  });
  return decision === 'allow';
}

export function buildImpressionsPromptBlocks(
  repository: StoreRepository,
  input: PromptBlocksInput,
  onTagPromptStates?: (updates: readonly TagPromptStateUpdate[]) => void,
): { groupTags?: string; memberTags?: string; impressions?: string; droppedTags: number } {
  const account = input.session.account;
  const identity = input.session.kind === 'group'
    ? resolveAccountIdentity(repository, {
      account,
      sessionId: input.sessionId,
      userId: input.senderId,
      fallbackName: input.senderName,
    })
    : undefined;
  const target = input.session.kind === 'private'
    ? { kind: 'private' as const, sessionId: input.sessionId, peerId: input.session.peer }
    : { kind: 'group' as const, sessionId: input.sessionId };
  let groupSelection: ReturnType<typeof selectInjectableTags> = {
    tags: [], dropped: 0, stateUpdates: [],
  };
  let groupAllowed = false;
  let memberSelection = { text: '', dropped: 0, profileText: '', stateUpdates: [] as TagPromptStateUpdate[] };
  if (input.session.kind === 'group' && identity) {
    const qqProfiles = createQqProfileService({ repository, now: () => input.now });
    groupAllowed = decide({
      info: { origin: 'group', sessionId: input.sessionId, ownerId: null },
      target,
      purpose: 'prompt',
    }) === 'allow';
    if (groupAllowed) {
      groupSelection = selectInjectableTags(repository.listTagsForSubject(account, input.sessionId, null)
        .filter((tag) => tag.kind === 'fact'), input.now, GROUP_TAGS_LIMIT, {
          renderText: (tags) => tags.map(displayTagText).join('、'),
        });
    }
    const memberAllowed = identity.userId !== account && decide({
      info: { origin: 'group', sessionId: input.sessionId, ownerId: identity.userId },
      target,
      purpose: 'prompt',
    }) === 'allow';
    if (memberAllowed) {
      memberSelection = buildMemberTagPrompt(
        repository.listTagsForSubject(account, input.sessionId, identity.userId)
          .filter((tag) => tag.kind === 'fact'),
        input.now,
        {
          ...qqProfiles.getCachedMemberProfile(account, input.session.peer, identity.userId),
          relationships: relationPromptLines(repository, account, input.sessionId, identity.userId),
        },
      );
    }
  }
  const subjectId = identity?.userId ?? (input.session.kind === 'private' ? input.session.peer : null);
  const eligibleViewTags = repository.listViewTagsForAccount(account)
    .filter((tag) => viewTagAllowed(tag, account, subjectId, target));
  const viewSelection = selectInjectableTags(eligibleViewTags, input.now, VIEW_TAGS_LIMIT, {
    includeMisc: true,
    renderText: (tags) => tags.map(displayViewTagText).join('、'),
  });
  onTagPromptStates?.([
    ...groupSelection.stateUpdates,
    ...memberSelection.stateUpdates,
    ...viewSelection.stateUpdates,
  ]);
  const blocks: { groupTags?: string; memberTags?: string; impressions?: string; droppedTags: number } = {
    droppedTags: groupSelection.dropped + memberSelection.dropped + viewSelection.dropped,
  };
  if (groupSelection.tags.length > 0) {
    blocks.groupTags = input.template.groupTags
      .replaceAll('{{tags}}', groupSelection.tags.map(displayTagText).join('、'));
  }
  if (identity && (memberSelection.text.length > 0 || memberSelection.profileText.length > 0 || identity.kind === 'bot')) {
    blocks.memberTags = input.template.memberTags
      .replaceAll('{{name}}', JSON.stringify(identity.kind === 'bot' ? `${identity.name}（bot）` : identity.name))
      .replaceAll('{{profile}}', memberSelection.profileText)
      .replaceAll('{{tags}}', memberSelection.text || '暂无已确认标签');
  }
  if (viewSelection.tags.length > 0) {
    blocks.impressions = input.template.impressions
      .replaceAll('{{tags}}', viewSelection.tags.map(displayViewTagText).join('、'));
  }
  return blocks;
}
