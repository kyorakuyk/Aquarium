import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OneBotAdapter } from '../src/adapters/onebot/adapter.ts';

const account = 900000001;

function createFixture(t: { after(callback: () => void): void }, wsServers: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-onebot-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, 'config');
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, `onebot_${account}.json`), JSON.stringify({
    networks: { wsServers },
  }), 'utf8');
  return root;
}

function groupEvent(userId: number, messageId: number, time: number) {
  return {
    time,
    self_id: account,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: 123456,
    user_id: userId,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    font: 0,
    sender: { user_id: userId, nickname: `user-${userId}` },
  };
}

function createFakeClient(loginUserId = account) {
  const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const messageListeners = new Set<(event: unknown) => void>();
  const state = {
    loginUserId,
    connectCalls: 0,
    closeCalls: 0,
    sentGroup: [] as unknown[],
    sentPrivate: [] as unknown[],
    markedGroup: [] as unknown[],
    markedPrivate: [] as unknown[],
    rawCalls: [] as unknown[],
    recalled: [] as unknown[],
    groupHistory: [] as unknown[],
    friendHistory: [] as unknown[],
  };

  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of eventListeners.get(event) ?? []) listener(...args);
  };

  return {
    state,
    client: {
      on(event: string, listener: (...args: unknown[]) => void) {
        const listeners = eventListeners.get(event) ?? new Set();
        listeners.add(listener);
        eventListeners.set(event, listeners);
        return () => listeners.delete(listener);
      },
      onMessage(listener: (event: unknown) => void) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      async connect() {
        state.connectCalls += 1;
        emit('open');
      },
      async getLoginInfo() {
        return { user_id: state.loginUserId, nickname: 'Aquarium' };
      },
      close() {
        state.closeCalls += 1;
        emit('close');
      },
      emitMessage(event: unknown) {
        for (const listener of messageListeners) listener(event);
      },
      async sendGroupMessage(...args: unknown[]) {
        state.sentGroup.push(args);
        return { message_id: 501 };
      },
      async sendPrivateMessage(...args: unknown[]) {
        state.sentPrivate.push(args);
        return { message_id: 502 };
      },
      async getGroupList() {
        return [{ group_id: 123456, group_name: '测试群', member_count: 8 }];
      },
      async getFriendList() {
        return [{ user_id: 42, nickname: '朋友', remark: '老友' }];
      },
      async getGroupMessageHistory() {
        return { messages: state.groupHistory };
      },
      async getFriendMessageHistory() {
        return { messages: state.friendHistory };
      },
      async markGroupMessageAsRead(...args: unknown[]) {
        state.markedGroup.push(args);
      },
      async markPrivateMessageAsRead(...args: unknown[]) {
        state.markedPrivate.push(args);
      },
      async raw(...args: unknown[]) {
        state.rawCalls.push(args);
      },
      async deleteMessage(...args: unknown[]) {
        state.recalled.push(args);
      },
    },
  };
}

test('读取首个 wsServers、启用重连并校验登录账号', async (t) => {
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
    reconnect: true,
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

test('onMessage 忽略自身消息并支持取消订阅', (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);
  const received: unknown[] = [];
  const unsubscribe = adapter.onMessage((message) => received.push(message));

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

test('好友与群列表使用 Aquarium 联系人字段', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);

  assert.deepEqual(await adapter.listGroups(), [{ groupId: 123456, name: '测试群', memberCount: 8 }]);
  assert.deepEqual(await adapter.listFriends(), [{ userId: 42, nickname: '朋友', remark: '老友' }]);
});

test('只给私聊设置输入状态，群聊不发送该动作', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);

  await adapter.setTyping({ account, kind: 'group', peer: 123456 });
  await adapter.setTyping({ account, kind: 'private', peer: 42 });

  assert.deepEqual(fake.state.rawCalls, [['set_input_status', { user_id: 42, event_type: 1 }]]);
});

test('recall 将消息号转换为 OneBot 数字 ID', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);

  await adapter.recall('123');

  assert.deepEqual(fake.state.recalled, [[123]]);
});
