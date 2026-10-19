import { message, type AnyMessageSegment, type OneBotMessageEvent } from '@snowluma/sdk';
import type { IncomingMessage, Segment } from '../../core/events.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function accountNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function convertOneBotSegment(raw: unknown): Segment {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !isRecord(raw.data)) {
    return { type: 'unknown', raw };
  }

  const data = raw.data;
  switch (raw.type) {
    case 'text':
      return typeof data.text === 'string'
        ? { type: 'text', text: data.text }
        : { type: 'unknown', raw };
    case 'at': {
      if (data.qq === 'all') return { type: 'at', target: 'all' };
      const target = accountNumber(data.qq);
      return target === undefined
        ? { type: 'unknown', raw }
        : { type: 'at', target };
    }
    case 'image': {
      const file = stringValue(data.file);
      const url = stringValue(data.url) ?? file;
      if (!url) return { type: 'unknown', raw };
      return file ? { type: 'image', url, file } : { type: 'image', url };
    }
    case 'reply': {
      const messageId = stringValue(data.id);
      return messageId === undefined
        ? { type: 'unknown', raw }
        : { type: 'reply', messageId };
    }
    case 'face': {
      const id = stringValue(data.id);
      return id === undefined
        ? { type: 'unknown', raw }
        : { type: 'face', id };
    }
    case 'mface': {
      const emojiId = stringValue(data.emoji_id) ?? stringValue(data.emojiId);
      return emojiId === undefined
        ? { type: 'unknown', raw }
        : { type: 'sticker', emojiId };
    }
    default:
      return { type: 'unknown', raw };
  }
}

function incomingSegments(messageValue: unknown): Segment[] {
  const rawSegments = Array.isArray(messageValue) ? messageValue : [messageValue];
  return rawSegments.map(convertOneBotSegment);
}

export function convertIncomingMessage(event: OneBotMessageEvent, account: number): IncomingMessage {
  const segments = incomingSegments(event.message);
  const senderName = event.message_type === 'group'
    ? event.sender.card || event.sender.nickname
    : event.sender.nickname;

  return {
    session: event.message_type === 'group'
      ? { account, kind: 'group', peer: event.group_id }
      : { account, kind: 'private', peer: event.user_id },
    messageId: String(event.message_id),
    senderId: event.user_id,
    senderName: senderName || String(event.user_id),
    segments,
    plainText: segments.filter((segment) => segment.type === 'text')
      .map((segment) => segment.text)
      .join(''),
    mentionsSelf: segments.some((segment) => segment.type === 'at' && segment.target === account),
    replyToSelf: false,
    time: event.time * 1000,
  };
}

export function shouldDispatchMessage(
  event: Pick<OneBotMessageEvent, 'user_id'>,
  account: number,
): boolean {
  return event.user_id !== account;
}

export function toOneBotSegments(segments: Segment[]): AnyMessageSegment[] {
  const converted: AnyMessageSegment[] = [];
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        converted.push(message.text(segment.text));
        break;
      case 'at':
        converted.push(message.at(segment.target));
        break;
      case 'image':
        converted.push(message.image(segment.file ?? segment.url, { url: segment.url }));
        break;
      case 'reply':
        converted.push(message.reply(segment.messageId));
        break;
      case 'face':
        converted.push(message.face(segment.id));
        break;
      case 'sticker':
        break;
      case 'unknown':
        break;
    }
  }
  return converted;
}
