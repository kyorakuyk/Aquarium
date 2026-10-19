import assert from 'node:assert/strict';
import test from 'node:test';
import {
  convertIncomingMessage,
  shouldDispatchMessage,
  toOneBotSegments,
} from '../src/adapters/onebot/convert.ts';
import type { IncomingMessage, Segment } from '../src/core/events.ts';

const account = 900000001;

function groupEvent(message: unknown, overrides: Record<string, unknown> = {}) {
  return {
    time: 1_700_000_000,
    self_id: account,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 99,
    group_id: 123456,
    user_id: 42,
    message,
    raw_message: '原始消息',
    font: 0,
    sender: { user_id: 42, nickname: '昵称', card: '群名片' },
    ...overrides,
  } as Parameters<typeof convertIncomingMessage>[0];
}

test('文本段映射为消息文本并按原顺序拼接 plainText', () => {
  const result = convertIncomingMessage(groupEvent([
    { type: 'text', data: { text: '你好' } },
    { type: 'text', data: { text: '，水族箱' } },
  ]), account);

  assert.deepEqual(result.segments, [
    { type: 'text', text: '你好' },
    { type: 'text', text: '，水族箱' },
  ]);
  assert.equal(result.plainText, '你好，水族箱');
  assert.equal(result.mentionsSelf, false);
});

test('只把指向当前账号的 at 计为 mentionsSelf', () => {
  const mention = convertIncomingMessage(groupEvent([
    { type: 'at', data: { qq: String(account) } },
    { type: 'text', data: { text: '在吗' } },
  ]), account);
  const atAll = convertIncomingMessage(groupEvent([
    { type: 'at', data: { qq: 'all' } },
  ]), account);

  assert.deepEqual(mention.segments[0], { type: 'at', target: account });
  assert.equal(mention.mentionsSelf, true);
  assert.equal(atAll.segments[0]?.type, 'at');
  assert.equal(atAll.mentionsSelf, false);
});

test('映射 image、reply、face，并将不支持的段保留为 unknown', () => {
  const rawUnknown = { type: 'video', data: { file: 'clip.mp4' } };
  const result = convertIncomingMessage(groupEvent([
    { type: 'image', data: { file: 'cache/image-1', url: 'https://example.invalid/image' } },
    { type: 'reply', data: { id: 88 } },
    { type: 'face', data: { id: 178 } },
    rawUnknown,
  ]), account);

  assert.deepEqual(result.segments, [
    { type: 'image', url: 'https://example.invalid/image', file: 'cache/image-1' },
    { type: 'reply', messageId: '88' },
    { type: 'face', id: '178' },
    { type: 'unknown', raw: rawUnknown },
  ]);
  assert.equal(result.plainText, '');
});

test('收到的 image 保留 sub_type=1 QQ 表情元数据', () => {
  const result = convertIncomingMessage(groupEvent([
    { type: 'image', data: { file: 'cache/sticker-1', url: 'https://example.invalid/sticker.gif', sub_type: 1 } },
  ]), account);

  assert.deepEqual(result.segments, [{
    type: 'image',
    url: 'https://example.invalid/sticker.gif',
    file: 'cache/sticker-1',
    subType: 1,
  }]);
});

test('私聊生成 private SessionKey，群名片优先于昵称', () => {
  const group = convertIncomingMessage(groupEvent([], {
    sender: { user_id: 42, nickname: '昵称', card: '群名片' },
  }), account);
  const privateEvent = {
    time: 1_700_000_000,
    self_id: account,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 100,
    user_id: 42,
    message: [],
    raw_message: '',
    font: 0,
    sender: { user_id: 42, nickname: '好友昵称' },
  } as Parameters<typeof convertIncomingMessage>[0];
  const privateMessage = convertIncomingMessage(privateEvent, account);

  assert.deepEqual(group.session, { account, kind: 'group', peer: 123456 });
  assert.equal(group.senderName, '群名片');
  assert.deepEqual(privateMessage.session, { account, kind: 'private', peer: 42 });
  assert.equal(privateMessage.senderName, '好友昵称');
  assert.equal(privateMessage.time, 1_700_000_000_000);
  assert.equal(privateMessage.replyToSelf, false);
});

test('只分发非自身消息', () => {
  const ownMessage = groupEvent([], { user_id: account });
  const otherMessage = groupEvent([], { user_id: 42 });

  assert.equal(shouldDispatchMessage(ownMessage, account), false);
  assert.equal(shouldDispatchMessage(otherMessage, account), true);
});

test('发送段转为 OneBot 消息段并丢弃 unknown', () => {
  const segments: Segment[] = [
    { type: 'text', text: '你好' },
    { type: 'at', target: account },
    { type: 'at', target: 'all' },
    { type: 'image', url: 'https://example.invalid/image', file: 'cache/image-1' },
    { type: 'reply', messageId: '88' },
    { type: 'face', id: '178' },
    { type: 'unknown', raw: { type: 'video' } },
  ];

  assert.deepEqual(toOneBotSegments(segments), [
    { type: 'text', data: { text: '你好' } },
    { type: 'at', data: { qq: String(account) } },
    { type: 'at', data: { qq: 'all' } },
    { type: 'image', data: { file: 'cache/image-1', url: 'https://example.invalid/image' } },
    { type: 'reply', data: { id: '88' } },
    { type: 'face', data: { id: '178' } },
  ]);
});

function assertIncomingMessage(value: IncomingMessage): void {
  assert.equal(typeof value.messageId, 'string');
}

test('转换结果满足公共 IncomingMessage 结构', () => {
  assertIncomingMessage(convertIncomingMessage(groupEvent([
    { type: 'text', data: { text: 'ok' } },
  ]), account));
});
