import { buildImpressionsPromptBlocks } from '../core/impressions/prompt-blocks.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { ReplySystemTemplate } from '../core/prompt/templates.ts';
import type { SessionKey } from '../core/shared/events.ts';
import type { StoredTag } from '../store/affect-repo.ts';
import type { StoreRepository } from '../store/repository.ts';

export interface ImpressionsLayoutContext {
  groupTagsText: string | null;
  groupScheduleDrop: { text: string; time: number } | undefined;
  memberIds: number[];
  messageActivity: Map<number, { messageCount: number; lastMessageTime: number }>;
  memberScheduleDrops: Map<number, { text: string; time: number }>;
}

export function buildImpressionsLayoutContext(input: {
  repository: StoreRepository;
  session: SessionKey;
  sessionId: string;
  now: number;
  tags: readonly StoredTag[];
  rosterUserIds: readonly number[];
  template: ReplySystemTemplate;
}): ImpressionsLayoutContext {
  const { repository, session, sessionId, now } = input;
  const groupPrompt = session.kind === 'group' ? buildImpressionsPromptBlocks(repository, {
    session,
    sessionId,
    senderId: session.account,
    senderName: '',
    now,
    template: input.template,
  }) : undefined;
  const messageActivity = new Map<number, { messageCount: number; lastMessageTime: number }>();
  if (session.kind === 'group') {
    for (const activity of repository.memberMessageStats(sessionId)) {
      const userId = repository.mainUserIdFor(session.account, activity.userId);
      if (userId === session.account) continue;
      const current = messageActivity.get(userId);
      messageActivity.set(userId, {
        messageCount: (current?.messageCount ?? 0) + activity.messageCount,
        lastMessageTime: Math.max(current?.lastMessageTime ?? 0, activity.lastMessageTime),
      });
    }
  }
  const memberIds = [...new Set([
    ...input.tags
      .map((tag) => tag.userId)
      .filter((userId): userId is number => userId !== null)
      .map((userId) => repository.mainUserIdFor(session.account, userId)),
    ...messageActivity.keys(),
    ...input.rosterUserIds.map((userId) => repository.mainUserIdFor(session.account, userId)),
  ])].filter((userId) => userId !== session.account);
  const since = Math.max(0, now - 7 * 24 * 60 * 60 * 1_000);
  const groupDrop = session.kind === 'group'
    ? repository.latestScheduleDrop(session.account, sessionId, null, since)
    : undefined;
  const memberScheduleDrops = new Map<number, { text: string; time: number }>();
  if (session.kind === 'group') {
    for (const userId of memberIds) {
      const drop = repository.latestScheduleDrop(session.account, sessionId, userId, since);
      if (drop) memberScheduleDrops.set(userId, { text: redactSensitiveText(drop.text), time: drop.time });
    }
  }
  return {
    groupTagsText: groupPrompt?.groupTags ? redactSensitiveText(groupPrompt.groupTags) : null,
    groupScheduleDrop: groupDrop ? { text: redactSensitiveText(groupDrop.text), time: groupDrop.time } : undefined,
    memberIds,
    messageActivity,
    memberScheduleDrops,
  };
}
