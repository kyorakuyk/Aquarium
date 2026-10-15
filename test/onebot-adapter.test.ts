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

function createTimerQueue() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  return {
    pending,
    set(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear(timer: ReturnType<typeof setTimeout>): void {
      pending.delete(timer as unknown as number);
    },
    runNext(): number | undefined {
      const next = pending.entries().next();
      if (next.done) return undefined;
      const [id, timer] = next.value;
      pending.delete(id);
      timer.callback();
      return timer.delay;
    },
  };
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

function createFakeClient(loginUserId = account, failedConnections = 0, hangFirstConnection = false, hangLoginInfo = false) {
  const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const messageListeners = new Set<(event: unknown) => void>();
  const state = {
    loginUserId,
    connectCalls: 0,
    closeCalls: 0,
    connected: false,
    hangNextConnection: false,
    pendingConnection: undefined as Promise<void> | undefined,
    disconnectBeforeGroupSend: false,
    hangGroupSend: false,
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
    emitClose() {
      state.connected = false;
      emit('close');
    },
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
        if (state.connected) return;
        if (state.pendingConnection) return state.pendingConnection;
        if (state.connectCalls <= failedConnections) throw new Error('fixture connection failure');
        if ((hangFirstConnection && state.connectCalls === 1) || state.hangNextConnection) {
          state.hangNextConnection = false;
          state.pendingConnection = new Promise<void>(() => {});
          return state.pendingConnection;
        }
        state.connected = true;
        emit('open');
      },
      get isConnected() { return state.connected; },
      async getLoginInfo() {
        if (hangLoginInfo) return new Promise<never>(() => {});
        return { user_id: state.loginUserId, nickname: 'Aquarium' };
      },
      close() {
        state.closeCalls += 1;
        state.connected = false;
        state.pendingConnection = undefined;
        emit('close');
      },
      emitMessage(event: unknown) {
        for (const listener of messageListeners) listener(event);
      },
      async sendGroupMessage(...args: unknown[]) {
        if (state.hangGroupSend) return new Promise<never>(() => {});
        if (state.disconnectBeforeGroupSend) {
          state.disconnectBeforeGroupSend = false;
          state.connected = false;
          state.hangNextConnection = true;
        }
        if (!state.connected) await this.connect();
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

test('start 在连接失败后按指数退避重试，直到连接成功', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient(account, 3);
  const retryTimers = createTimerQueue();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
  });
  const statuses: string[] = [];
  adapter.onStatus((status) => statuses.push(status));

  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.state.connectCalls, 1);
  assert.equal(fake.state.closeCalls, 0);
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [2_000]);

  assert.equal(retryTimers.runNext(), 2_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [4_000]);
  assert.equal(retryTimers.runNext(), 4_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [8_000]);
  assert.equal(retryTimers.runNext(), 8_000);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fake.state.connectCalls, 4);
  assert.equal(fake.state.closeCalls, 0);
  assert.equal(statuses.at(-1), 'online');
  assert.equal(retryTimers.pending.size, 0);
  adapter.close();
});

test('retryNow 清除退避并立即重试', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient(account, 1);
  const retryTimers = createTimerQueue();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
  });

  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [2_000]);
  adapter.retryNow();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fake.state.connectCalls, 2);
  assert.equal(adapter.nickname, 'Aquarium');
  assert.equal(retryTimers.pending.size, 0);
  adapter.close();
});

test('retryNow 会修复状态仍在线但底层 socket 已断开的竞态', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const retryTimers = createTimerQueue();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
  });
  const statuses: string[] = [];
  adapter.onStatus((status) => statuses.push(status));
  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));

  fake.state.connected = false;
  adapter.retryNow();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fake.state.connectCalls, 2);
  assert.equal(statuses.at(-1), 'online');
  assert.equal(retryTimers.pending.size, 0);
  adapter.close();
});

test('退避封顶三十秒，close 会清除待处理的重试', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient(account, 6);
  const retryTimers = createTimerQueue();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
  });

  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [delay]);
    assert.equal(retryTimers.runNext(), delay);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(fake.state.connectCalls, 7);
  assert.equal(adapter.nickname, 'Aquarium');

  fake.client.close();
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [2_000]);
  adapter.close();
  assert.equal(retryTimers.pending.size, 0);
});

test('每次应用层重连都会重新校验登录 UIN', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const retryTimers = createTimerQueue();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
  });
  const statuses: string[] = [];
  adapter.onStatus((status) => statuses.push(status));

  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(statuses.at(-1), 'online');

  fake.state.loginUserId = account + 1;
  fake.client.close();
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [2_000]);
  retryTimers.runNext();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fake.state.connectCalls, 2);
  assert.equal(fake.state.closeCalls, 2);
  assert.equal(statuses.at(-1), 'offline');
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [4_000]);
  adapter.close();
});

test('登录账号尚未验证时不分发 OneBot 消息', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient(account + 1, 0, false, true);
  const retryTimers = createTimerQueue();
  const actionTimers = createTimerQueue();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
    setActionTimer: actionTimers.set,
    clearActionTimer: actionTimers.clear,
  });
  const received: unknown[] = [];
  adapter.onMessage((message) => received.push(message));
  t.after(() => adapter.close());

  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  fake.client.emitMessage(groupEvent(42, 901, Math.floor(Date.now() / 1000)));

  assert.equal(fake.state.connected, true);
  assert.equal(received.length, 0);
});

test('卡住的 WebSocket 握手会超时清理并继续应用层重试', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient(account, 0, true);
  const retryTimers = createTimerQueue();
  const actionTimers = createTimerQueue();
  const statuses: string[] = [];
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
    setActionTimer: actionTimers.set,
    clearActionTimer: actionTimers.clear,
  });
  adapter.onStatus((status) => statuses.push(status));

  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...actionTimers.pending.values()].map((timer) => timer.delay), [10_000]);
  assert.equal(actionTimers.runNext(), 10_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.state.closeCalls, 1);
  assert.equal(statuses.at(-1), 'offline');
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [2_000]);

  retryTimers.runNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.state.connectCalls, 2);
  assert.equal(statuses.at(-1), 'online');
  adapter.close();
});

test('握手超时后替换 SDK client，旧 socket 的迟到 close 不覆盖新连接', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const first = createFakeClient(account, 0, true);
  const second = createFakeClient();
  const clients = [first.client, second.client];
  const retryTimers = createTimerQueue();
  const actionTimers = createTimerQueue();
  const statuses: string[] = [];
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => {
    const next = clients.shift();
    if (!next) throw new Error('no fake client remains');
    return next;
  }, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
    setActionTimer: actionTimers.set,
    clearActionTimer: actionTimers.clear,
  });
  adapter.onStatus((status) => statuses.push(status));

  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  actionTimers.runNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  retryTimers.runNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(statuses.at(-1), 'online');

  first.emitClose();

  assert.equal(statuses.at(-1), 'online');
  assert.equal(retryTimers.pending.size, 0);
  adapter.close();
});

test('get_login_info 超时会替换仍保持连接的 SDK client', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const first = createFakeClient(account, 0, false, true);
  const second = createFakeClient();
  const clients = [first.client, second.client];
  const retryTimers = createTimerQueue();
  const actionTimers = createTimerQueue();
  const statuses: string[] = [];
  let factoryCalls = 0;
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => {
    factoryCalls += 1;
    const next = clients.shift();
    if (!next) throw new Error('no fake client remains');
    return next;
  }, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
    setActionTimer: actionTimers.set,
    clearActionTimer: actionTimers.clear,
  });
  adapter.onStatus((status) => statuses.push(status));
  t.after(() => adapter.close());

  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(first.state.connected, true);
  assert.equal(actionTimers.pending.size, 1);
  actionTimers.runNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  retryTimers.runNext();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(factoryCalls, 2);
  assert.equal(statuses.at(-1), 'online');
  adapter.close();
});

test('公开动作超时会让仍连接的 socket 离线并替换 client', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const first = createFakeClient();
  const second = createFakeClient();
  const clients = [first.client, second.client];
  const retryTimers = createTimerQueue();
  const actionTimers = createTimerQueue();
  const statuses: string[] = [];
  let factoryCalls = 0;
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => {
    factoryCalls += 1;
    const next = clients.shift();
    if (!next) throw new Error('no fake client remains');
    return next;
  }, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
    setActionTimer: actionTimers.set,
    clearActionTimer: actionTimers.clear,
  });
  adapter.onStatus((status) => statuses.push(status));
  t.after(() => adapter.close());

  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  first.state.hangGroupSend = true;
  const sending = adapter.send(
    { account, kind: 'group', peer: 123456 },
    [{ type: 'text', text: 'hello' }],
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(first.state.connected, true);
  actionTimers.runNext();
  await assert.rejects(sending, /timed out/);

  assert.equal(statuses.at(-1), 'offline');
  assert.equal(first.state.closeCalls, 1);
  retryTimers.runNext();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(factoryCalls, 2);
  assert.equal(statuses.at(-1), 'online');
  adapter.close();
});

test('适配器动作总超时覆盖断线后等待重连握手的时间', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const retryTimers = createTimerQueue();
  const actionTimers = createTimerQueue();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
    setActionTimer: actionTimers.set,
    clearActionTimer: actionTimers.clear,
  });
  const statuses: string[] = [];
  adapter.onStatus((status) => statuses.push(status));
  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(statuses.at(-1), 'online');

  fake.state.disconnectBeforeGroupSend = true;
  const action = adapter.send({ account, kind: 'group', peer: 123456 }, []);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...actionTimers.pending.values()].map((timer) => timer.delay), [10_000]);
  const rejection = assert.rejects(action, /timed out after 10000ms/u);
  actionTimers.runNext();
  await rejection;

  assert.equal(statuses.at(-1), 'offline');
  assert.equal(fake.state.closeCalls, 1);
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [2_000]);
  adapter.close();
});

test('adapter 状态在线但底层 WebSocket 已断开时动作 fail fast', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const retryTimers = createTimerQueue();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
  });
  adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));

  fake.state.connected = false;
  await assert.rejects(adapter.send({ account, kind: 'group', peer: 123456 }, []), /not online/u);
  assert.equal(fake.state.connectCalls, 1);
  assert.equal(fake.state.sentGroup.length, 0);
  adapter.close();
});

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
    requestTimeoutMs: 10_000,
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
