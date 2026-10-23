import type { SnowLumaEvent } from '@snowluma/sdk';
import type { EmojiLikeNotice } from '../types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function safeMessageId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isSafeInteger(Number(value))) return value;
  return undefined;
}

export function convertEmojiLikeNotice(event: unknown, account: number): EmojiLikeNotice | undefined {
  if (!isRecord(event) || event.post_type !== 'notice' || event.notice_type !== 'group_msg_emoji_like') {
    return undefined;
  }
  const selfId = safeInteger(event.self_id);
  const groupId = safeInteger(event.group_id);
  const userId = safeInteger(event.user_id);
  const messageId = safeMessageId(event.message_id);
  if ((event.self_id !== undefined && (selfId === undefined || selfId !== account))
    || groupId === undefined || groupId <= 0
    || userId === undefined || userId <= 0
    || messageId === undefined
    || (event.sub_type !== 'add' && event.sub_type !== 'remove')
    || !Array.isArray(event.likes)) {
    return undefined;
  }
  const likes = event.likes.flatMap((item) => {
    if (!isRecord(item) || typeof item.emoji_id !== 'string' || item.emoji_id.length === 0
      || typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 0) {
      return [];
    }
    return [{ emojiId: item.emoji_id, count: item.count }];
  });
  if (likes.length === 0) return undefined;
  return {
    type: 'emoji_like',
    session: { account, kind: 'group', peer: groupId },
    messageId,
    userId,
    subType: event.sub_type,
    likes,
  };
}

export function createOneBotEventHandler(options: {
  account: number;
  isCurrent: () => boolean;
  isAccountVerified: () => boolean;
  recordPacket: (event: SnowLumaEvent) => void;
  onInteractionNotice?: (notice: EmojiLikeNotice) => void;
  onError?: (error: unknown) => void;
}): (event: SnowLumaEvent) => void {
  return (event) => {
    if (!options.isCurrent()) return;
    options.recordPacket(event);
    if (!options.isAccountVerified() || !options.onInteractionNotice) return;
    const notice = convertEmojiLikeNotice(event, options.account);
    if (!notice) return;
    try {
      options.onInteractionNotice(notice);
    } catch (error) {
      try { options.onError?.(error); } catch { /* 隔离事件分发错误 */ }
    }
  };
}
