import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnchoredContextWindow } from '../src/core/conversation/context-window.ts';
import type { MessageStorageRecord } from '../src/store/repository.ts';

function message(messageId: string, time: number): MessageStorageRecord {
  return {
    sessionId: 'session-1',
    messageId,
    senderId: time,
    senderName: 'member',
    isSelf: false,
    plainText: messageId,
    segments: [],
    time,
  };
}

function messages(from: number, through: number): MessageStorageRecord[] {
  return Array.from({ length: through - from + 1 }, (_, index) => {
    const value = from + index;
    return message(`m${value}`, value);
  });
}

function ids(records: MessageStorageRecord[]): string[] {
  return records.map(({ messageId }) => messageId);
}

test('锚定窗口超过 ceil(1.5N) 后前移并恢复为 N 条', () => {
  const window = createAnchoredContextWindow();

  assert.deepEqual(ids(window.select('session-1', 4, messages(1, 4))), ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual(ids(window.select('session-1', 4, messages(1, 6))), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  assert.deepEqual(ids(window.select('session-1', 4, messages(1, 7))), ['m4', 'm5', 'm6', 'm7']);
});

test('锚点不在最近 2N 条消息中时重新锚定', () => {
  const window = createAnchoredContextWindow();

  window.select('session-1', 4, messages(1, 4));
  assert.deepEqual(ids(window.select('session-1', 4, messages(5, 12))), ['m9', 'm10', 'm11', 'm12']);
});
