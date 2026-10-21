import assert from 'node:assert/strict';
import test from 'node:test';
import { OneBotAdapter } from '../src/adapters/onebot/adapter.ts';
import {
  account,
  createFakeClient,
  createFixture,
  createTimerQueue,
  groupEvent,
} from './onebot-adapter-test-helpers.ts';
test('离线时所有公开 OneBot 动作立即 fail fast', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);
  const session = { account, kind: 'group' as const, peer: 123456 };

  await assert.rejects(adapter.send(session, []), /not online/u);
  await assert.rejects(adapter.listGroups(), /not online/u);
  await assert.rejects(adapter.listFriends(), /not online/u);
  await assert.rejects(adapter.history(session, 1), /not online/u);
  await assert.rejects(adapter.markRead(session), /not online/u);
  await assert.rejects(adapter.setTyping(session), /not online/u);
  await assert.rejects(adapter.recall('1'), /not online/u);
  await assert.rejects(adapter.getGroupInfo(session.peer), /not online/u);
  await assert.rejects(adapter.getGroupMembers(session.peer), /not online/u);
  await assert.rejects(adapter.getGroupHonors(session.peer), /not online/u);
  await assert.rejects(adapter.getStrangerInfo(42), /not online/u);
  await assert.rejects(adapter.getGroupNoticeLatest(session.peer), /not online/u);
  await assert.rejects(adapter.getEssenceCount(session.peer), /not online/u);
  assert.equal(fake.state.connectCalls, 0);
});

test('读取首个 wsServers、关闭 SDK 重连并校验登录账号', async (t) => {
  const root = createFixture(t, [
    { host: '127.0.0.1', port: 3001, path: '/onebot' },
    { host: '127.0.0.2', port: 3002, path: '/ignored' },
  ]);
  const fake = createFakeClient();
  let capturedOptions: unknown;
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, (options: unknown) => {
    capturedOptions = options;
    return fake.client;
  });
  const statuses: string[] = [];
  adapter.onStatus((status) => statuses.push(status));

  await adapter.connect();

  assert.deepEqual(capturedOptions, {
    url: 'ws://127.0.0.1:3001/onebot',
    accessToken: undefined,
    requestTimeoutMs: 60_000,
    reconnect: false,
  });
  assert.equal(fake.state.connectCalls, 1);
  assert.deepEqual(statuses, ['connecting', 'online']);
  adapter.close();
  assert.equal(statuses.at(-1), 'offline');
});

test('连接后公开已校验登录账号的昵称供人设占位使用', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);

  await adapter.connect();

  assert.equal(adapter.nickname, 'Aquarium');
  adapter.close();
});

test('拒绝连接到与配置账号不一致的登录账号', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient(account + 1);
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);
  const statuses: string[] = [];
  adapter.onStatus((status) => statuses.push(status));

  await assert.rejects(adapter.connect(), /与配置账号 .* 不一致/);
  assert.equal(fake.state.closeCalls, 1);
  assert.deepEqual(statuses, ['connecting', 'offline']);
});

test('onMessage 忽略自身消息并支持取消订阅', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);
  const received: unknown[] = [];
  const unsubscribe = adapter.onMessage((message) => received.push(message));

  await adapter.connect();
  fake.client.emitMessage(groupEvent(account, 10, 1_700_000_000));
  fake.client.emitMessage(groupEvent(42, 11, 1_700_000_001));
  unsubscribe();
  fake.client.emitMessage(groupEvent(43, 12, 1_700_000_002));

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    session: { account, kind: 'group', peer: 123456 },
    messageId: '11',
    senderId: 42,
    senderName: 'user-42',
    segments: [{ type: 'text', text: 'hello' }],
    plainText: 'hello',
    mentionsSelf: false,
    replyToSelf: false,
    time: 1_700_000_001_000,
  });
});

test('发送、历史顺序与标记已读保持在当前会话范围内', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  fake.state.groupHistory.push(
    groupEvent(42, 20, 1_700_000_002),
    groupEvent(43, 19, 1_700_000_001),
  );
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);
  const session = { account, kind: 'group' as const, peer: 123456 };

  await adapter.connect();
  const sent = await adapter.send(session, [
    { type: 'text', text: 'hello' },
    { type: 'unknown', raw: { type: 'video' } },
  ]);
  const history = await adapter.history(session, 2);
  await adapter.markRead(session);

  assert.deepEqual(sent, { messageId: '501' });
  assert.deepEqual(fake.state.sentGroup, [[123456, [{ type: 'text', data: { text: 'hello' } }]]]);
  assert.deepEqual(history.map((message) => message.messageId), ['19', '20']);
  assert.deepEqual(fake.state.markedGroup, [[20, 123456]]);
});

test('自定义表情动作映射详情、添加、修改备注与 get_image', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  fake.state.rawResults.set('fetch_custom_face_detail', [{
    emoji_id: 'emoji-1',
    resId: 'res-1',
    url: 'https://gchat.qpic.cn/sticker.png',
    md5: '0123456789abcdef0123456789abcdef',
    desc: 'QQ 备注',
  }]);
  fake.state.rawResults.set('add_custom_face', { emoji_id: 'emoji-2' });
  fake.state.rawResults.set('send_custom_face', { message_id: 777 });
  fake.state.imageInfo = { url: 'https://gchat.qpic.cn/refreshed.png' };
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);
  t.after(() => adapter.close());
  await adapter.connect();

  assert.deepEqual(await adapter.customFaces.fetchDetails(300), [{
    emojiId: 'emoji-1',
    resId: 'res-1',
    url: 'https://gchat.qpic.cn/sticker.png',
    md5: '0123456789abcdef0123456789abcdef',
    desc: 'QQ 备注',
  }]);
  assert.deepEqual(await adapter.customFaces.addCustomFace('base64://AAAA'), { emojiId: 'emoji-2' });
  await adapter.customFaces.modifyCustomFace('emoji-2', '新的备注');
  assert.equal(await adapter.customFaces.getImageUrl('file-1'), 'https://gchat.qpic.cn/refreshed.png');
  assert.deepEqual(
    await adapter.customFaces.sendCustomFace({ session: { account, kind: 'group', peer: 123456 }, emojiId: 'emoji-2' }),
    { messageId: '777' },
  );
  assert.deepEqual(fake.state.rawCalls, [
    ['fetch_custom_face_detail', { count: 300 }],
    ['add_custom_face', { file: 'base64://AAAA' }],
    ['modify_custom_face', { emoji_id: 'emoji-2', desc: '新的备注' }],
    ['send_custom_face', { emoji_id: 'emoji-2', group_id: 123456 }],
  ]);
  assert.deepEqual(fake.state.imageCalls, [{ file: 'file-1' }]);
});

test('相同会话的纯文本在窗口内只发送一次，并在窗口过期后恢复发送', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const debug: string[] = [];
  let now = 1_000;
  const adapter = new OneBotAdapter({
    account,
    snowlumaDir: root,
    getSendDedupeWindowMs: () => 8_000,
    onDebug: (message) => debug.push(message),
  }, () => fake.client, { now: () => now });
  t.after(() => adapter.close());
  await adapter.connect();
  const session = { account, kind: 'group' as const, peer: 123456 };
  const text = [{ type: 'text', text: '相同内容' }] as const;

  const first = await adapter.send(session, [...text]);
  now += 7_999;
  const duplicate = await adapter.send(session, [...text]);
  await adapter.send({ ...session, peer: 654321 }, [...text]);
  now += 1;
  await adapter.send(session, [...text]);

  assert.deepEqual(duplicate, first);
  assert.equal(fake.state.sentGroup.length, 3);
  assert.equal(debug.length, 1);
  assert.match(debug[0]!, /重复文本发送已跳过/);
});

test('dedupeWindowMs 为 0 时不抑制重复文本', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  let now = 1_000;
  const adapter = new OneBotAdapter({
    account,
    snowlumaDir: root,
    getSendDedupeWindowMs: () => 0,
  }, () => fake.client, { now: () => now });
  t.after(() => adapter.close());
  await adapter.connect();
  const session = { account, kind: 'group' as const, peer: 123456 };
  const text = [{ type: 'text', text: '相同内容' }] as const;

  await adapter.send(session, [...text]);
  now += 1;
  await adapter.send(session, [...text]);

  assert.equal(fake.state.sentGroup.length, 2);
});

test('群聊历史分页传递负数锚点并去掉重复锚点消息', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  fake.state.groupHistory.push(
    groupEvent(42, -123, 1_700_000_002),
    groupEvent(43, -456, 1_700_000_001),
  );
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);
  const session = { account, kind: 'group' as const, peer: 123456 };

  await adapter.connect();
  const history = await adapter.history(session, { count: 50, beforeMessageId: -123 });

  assert.deepEqual(fake.state.groupHistoryCalls, [{
    group_id: 123456,
    count: 50,
    message_id: -123,
    reverse_order: true,
  }]);
  assert.deepEqual(history.map((message) => message.messageId), ['-456']);
});

test('好友与群列表使用 Aquarium 联系人字段', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);

  await adapter.connect();
  assert.deepEqual(await adapter.listGroups(), [{ groupId: 123456, name: '测试群', memberCount: 8 }]);
  assert.deepEqual(await adapter.listFriends(), [{ userId: 42, nickname: '朋友', remark: '老友' }]);
});

test('只给私聊设置输入状态，群聊不发送该动作', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);

  await adapter.connect();
  await adapter.setTyping({ account, kind: 'group', peer: 123456 });
  await adapter.setTyping({ account, kind: 'private', peer: 42 });

  assert.deepEqual(fake.state.rawCalls, [['set_input_status', { user_id: 42, event_type: 1 }]]);
});

test('recall 将消息号转换为 OneBot 数字 ID', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);

  await adapter.connect();
  await adapter.recall('123');

  assert.deepEqual(fake.state.recalled, [[123]]);
});
