import assert from 'node:assert/strict';
import test from 'node:test';
import { startAdapterForHost } from '../src/app/adapter-start.ts';
import { OneBotAdapter } from '../src/adapters/onebot/adapter.ts';
import {
  account,
  createFakeClient,
  createFixture,
  createTimerQueue,
  groupEvent,
} from './onebot-adapter-test-helpers.ts';

function runTimerWithDelay(timers: ReturnType<typeof createTimerQueue>, delay: number): void {
  const entry = [...timers.pending.entries()].find(([, timer]) => timer.delay === delay);
  assert.ok(entry, `expected a ${delay}ms timer`);
  timers.pending.delete(entry[0]);
  entry[1].callback();
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

  startAdapterForHost(adapter, { managed: false, ready: false });
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

test('托管账号等待注入，注入后按 3 秒超时和 1 秒间隔快速重连', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient(account, 0, true);
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

  startAdapterForHost(adapter, { managed: true, ready: false });
  assert.equal(statuses.at(-1), 'waiting_login');
  assert.equal(fake.state.connectCalls, 0);

  startAdapterForHost(adapter, { managed: true, ready: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.state.connectCalls, 1);
  assert.deepEqual([...actionTimers.pending.values()].map((timer) => timer.delay), [3_000]);
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [30_000]);

  assert.equal(actionTimers.runNext(), 3_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay).sort((a, b) => a - b), [1_000, 30_000]);
  runTimerWithDelay(retryTimers, 1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fake.state.connectCalls, 2);
  assert.equal(statuses.at(-1), 'online');
  assert.equal(retryTimers.pending.size, 0);
  adapter.close();
});

test('30 秒快速重连窗口结束后恢复指数退避', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient(account, 10);
  const retryTimers = createTimerQueue();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client, {
    setRetryTimer: retryTimers.set,
    clearRetryTimer: retryTimers.clear,
  });

  adapter.waitForLogin();
  adapter.retryNow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.state.connectCalls, 1);
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay).sort((a, b) => a - b), [1_000, 30_000]);

  runTimerWithDelay(retryTimers, 30_000);
  assert.deepEqual([...retryTimers.pending.values()].map((timer) => timer.delay), [2_000]);
  adapter.close();
  assert.equal(retryTimers.pending.size, 0);
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
