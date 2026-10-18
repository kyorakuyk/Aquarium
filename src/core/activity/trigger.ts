import type { IncomingMessage } from '../events.ts';

export type MessageTrigger = 'private' | 'mention' | 'nickname' | 'none';

export function messageTrigger(
  message: Pick<IncomingMessage, 'session' | 'mentionsSelf' | 'plainText'>,
  nicknames: readonly string[],
): MessageTrigger {
  if (message.session.kind === 'private') return 'private';
  if (message.mentionsSelf) return 'mention';
  const calledByNickname = nicknames.some((nickname) => {
    const normalized = nickname.trim();
    return normalized !== '' && message.plainText.includes(normalized);
  });
  return calledByNickname ? 'nickname' : 'none';
}
