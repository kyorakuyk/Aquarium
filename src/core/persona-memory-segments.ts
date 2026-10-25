export const GROUP_MEMORY_SILENCE_MS = 20 * 60_000;
export const PRIVATE_MEMORY_SILENCE_MS = 40 * 60_000;
export const MEMORY_SEGMENT_SPLIT_GAP_MS = 3 * 60_000;
export const GROUP_MEMORY_SEGMENT_LIMIT = 80;
export const PRIVATE_MEMORY_SEGMENT_LIMIT = 60;

export interface MemorySegmentMessage {
  messageId: string;
  time: number;
  senderId: number;
  isSelf: boolean;
  plainText: string;
}

export interface MemorySegment {
  startAt: number;
  endAt: number;
  messages: MemorySegmentMessage[];
  closed: boolean;
}

export function memorySilenceMs(sessionKind: 'group' | 'private'): number {
  return sessionKind === 'group' ? GROUP_MEMORY_SILENCE_MS : PRIVATE_MEMORY_SILENCE_MS;
}

function toSegment(messages: MemorySegmentMessage[], closed: boolean): MemorySegment {
  return {
    startAt: messages[0]?.time ?? 0,
    endAt: messages.at(-1)?.time ?? 0,
    messages,
    closed,
  };
}

function lastLongGapIndex(messages: readonly MemorySegmentMessage[]): number {
  let splitAt = -1;
  for (let index = 1; index < messages.length; index += 1) {
    if ((messages[index]?.time ?? 0) - (messages[index - 1]?.time ?? 0) >= MEMORY_SEGMENT_SPLIT_GAP_MS) {
      splitAt = index;
    }
  }
  return splitAt;
}

export function segmentMemoryMessages(input: {
  sessionKind: 'group' | 'private';
  messages: readonly MemorySegmentMessage[];
  now: number;
}): MemorySegment[] {
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new RangeError('记忆分段时间无效');
  for (const message of input.messages) {
    if (typeof message.messageId !== 'string' || message.messageId.length === 0
      || !Number.isSafeInteger(message.time) || message.time < 0
      || !Number.isSafeInteger(message.senderId) || message.senderId < 0
      || typeof message.isSelf !== 'boolean' || typeof message.plainText !== 'string') {
      throw new RangeError('记忆分段消息无效');
    }
  }
  const messages = [...input.messages].sort((first, second) => first.time - second.time
    || first.messageId.localeCompare(second.messageId));
  const silenceMs = memorySilenceMs(input.sessionKind);
  const limit = input.sessionKind === 'group' ? GROUP_MEMORY_SEGMENT_LIMIT : PRIVATE_MEMORY_SEGMENT_LIMIT;
  const segments: MemorySegment[] = [];
  let open: MemorySegmentMessage[] = [];

  for (const message of messages) {
    const previous = open.at(-1);
    if (previous && message.time - previous.time >= silenceMs) {
      segments.push(toSegment(open, true));
      open = [];
    }
    open.push(message);
    while (open.length >= limit) {
      const splitAt = lastLongGapIndex(open);
      if (splitAt < 0) break;
      segments.push(toSegment(open.slice(0, splitAt), true));
      open = open.slice(splitAt);
    }
  }

  if (open.length > 0) {
    const last = open.at(-1);
    segments.push(toSegment(open, last !== undefined && input.now - last.time >= silenceMs));
  }
  return segments;
}
