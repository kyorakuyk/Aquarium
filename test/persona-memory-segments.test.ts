import assert from 'node:assert/strict';
import test from 'node:test';
import * as personaMemory from '../src/core/persona-memory.ts';

type SegmentMessage = { messageId: string; time: number; senderId: number; isSelf: boolean; plainText: string };
type Segment = { startAt: number; endAt: number; messages: SegmentMessage[]; closed: boolean };
type SegmentMemoryMessages = (input: {
  sessionKind: 'group' | 'private';
  messages: readonly SegmentMessage[];
  now: number;
}) => Segment[];

function segmenter(): SegmentMemoryMessages | undefined {
  const value = Reflect.get(personaMemory, 'segmentMemoryMessages') as SegmentMemoryMessages | undefined;
  assert.equal(typeof value, 'function');
  return value;
}

function messages(count: number, gapAfter?: number, gapMs = 0): SegmentMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `m-${index}`,
    time: index * 60_000 + (gapAfter !== undefined && index > gapAfter ? gapMs : 0),
    senderId: 42,
    isSelf: false,
    plainText: `message-${index}`,
  }));
}

test('群聊 20 分钟与私聊 40 分钟静默边界会闭合前段', () => {
  const split = segmenter();
  if (!split) return;
  const group = split({ sessionKind: 'group', messages: messages(2, 0, 19 * 60_000), now: 20 * 60_000 });
  assert.deepEqual(group.map(({ messages: items, closed }) => [items.length, closed]), [[1, true], [1, false]]);
  const privateChat = split({ sessionKind: 'private', messages: messages(2, 0, 39 * 60_000), now: 40 * 60_000 });
  assert.deepEqual(privateChat.map(({ messages: items, closed }) => [items.length, closed]), [[1, true], [1, false]]);
});

test('达到群聊 80 条时在最后一个至少 3 分钟的间隙切段', () => {
  const split = segmenter();
  if (!split) return;
  const result = split({ sessionKind: 'group', messages: messages(80, 39, 3 * 60_000), now: 90 * 60_000 });
  assert.deepEqual(result.map(({ messages: items, closed }) => [items.length, closed]), [[40, true], [40, false]]);
});

test('没有 3 分钟间隙时按会话提取上限切分且不丢消息', () => {
  const split = segmenter();
  if (!split) return;
  const groupMessages = messages(81);
  const group = split({ sessionKind: 'group', messages: groupMessages, now: groupMessages.at(-1)!.time + 1 });
  assert.deepEqual(group.map(({ messages: items, closed }) => [items.length, closed]), [[80, true], [1, false]]);
  assert.deepEqual(group.flatMap(({ messages: items }) => items.map(({ messageId }) => messageId)),
    groupMessages.map(({ messageId }) => messageId));

  const privateMessages = messages(61);
  const privateChat = split({ sessionKind: 'private', messages: privateMessages, now: privateMessages.at(-1)!.time + 1 });
  assert.deepEqual(privateChat.map(({ messages: items, closed }) => [items.length, closed]), [[60, true], [1, false]]);
  assert.deepEqual(privateChat.flatMap(({ messages: items }) => items.map(({ messageId }) => messageId)),
    privateMessages.map(({ messageId }) => messageId));
});
