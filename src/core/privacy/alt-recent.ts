import type { StoreRepository } from '../../store/repository.ts';
import { linkedAccountUserIds } from '../profiles/account-identity.ts';
import { redactSensitiveText } from '../impressions/sensitive-text.ts';
import { decide } from './policy.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import type { ReplySystemTemplate } from '../prompt/templates.ts';

const ALT_RECENT_WINDOW_MS = 6 * 60 * 60_000;
const ALT_RECENT_MESSAGE_LIMIT = 12;
const ALT_RECENT_CHARACTER_LIMIT = 800;

function textLength(value: string): number {
  return Array.from(value).length;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function buildAltRecentBlock(
  repository: StoreRepository,
  input: { session: SessionKey; now: number; template: ReplySystemTemplate },
): string | undefined {
  const { session, now, template } = input;
  if (session.kind !== 'private' || !Number.isSafeInteger(session.account) || session.account <= 0
    || !Number.isSafeInteger(session.peer) || session.peer <= 0
    || !Number.isSafeInteger(now) || now < 0) return undefined;

  const mainUserId = repository.mainUserIdFor(session.account, session.peer);
  const otherPeerIds = linkedAccountUserIds(repository, session.account, session.peer)
    .filter((userId) => userId !== session.peer);
  if (otherPeerIds.length === 0) return undefined;

  const targetSessionId = sessionId(session);
  const target = { kind: 'private' as const, sessionId: targetSessionId, peerId: mainUserId };
  const earliestTime = Math.max(0, now - ALT_RECENT_WINDOW_MS);
  const candidates = otherPeerIds.flatMap((peerId) => {
    const sourceSessionId = sessionId({ ...session, peer: peerId });
    return repository.recentMessages(sourceSessionId, ALT_RECENT_MESSAGE_LIMIT)
      .filter((message) => message.sessionId === sourceSessionId
        && Number.isSafeInteger(message.time) && message.time >= earliestTime && message.time <= now)
      .filter(() => decide({
        info: {
          origin: 'private',
          sessionId: sourceSessionId,
          ownerId: repository.mainUserIdFor(session.account, peerId),
          level: 'L0',
        },
        target,
        purpose: 'prompt',
      }) === 'allow');
  }).sort((first, second) => first.time - second.time
    || first.sessionId.localeCompare(second.sessionId)
    || first.messageId.localeCompare(second.messageId))
    .slice(-ALT_RECENT_MESSAGE_LIMIT);
  if (candidates.length === 0) return undefined;

  const selected: Array<{ time: string; sender: string; text: string }> = [];
  for (const message of [...candidates].reverse()) {
    const entry = {
      time: formatTime(message.time),
      sender: redactSensitiveText(message.senderName),
      text: redactSensitiveText(message.plainText),
    };
    const orderedEntries = [...selected, entry].reverse();
    const candidateBlock = template.altRecent.replaceAll('{{messages}}', JSON.stringify(orderedEntries));
    if (textLength(candidateBlock) <= ALT_RECENT_CHARACTER_LIMIT) selected.push(entry);
  }
  if (selected.length === 0) return undefined;

  return template.altRecent.replaceAll('{{messages}}', JSON.stringify(selected.reverse()));
}
