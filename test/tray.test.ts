import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host, HostStatus } from '../src/host/types.ts';

test('空托盘只记录接口调用，不触发菜单行为，并在 dispose 后静默', async () => {
  const imported = await import('../src/host/tray.ts').catch(() => undefined);
  assert.ok(imported, 'host tray module should exist');
  const api = imported as unknown as {
    createLogOnlyTray?: (log: (message: string) => void) => {
      setState: (state: HostStatus, tooltip: string) => void;
      onMenu: (handler: (action: string) => void) => void;
      notify: (text: string) => void;
      dispose: () => void;
    };
  };
  assert.equal(typeof api.createLogOnlyTray, 'function');

  const logs: string[] = [];
  let menuCalls = 0;
  const tray = api.createLogOnlyTray?.((message) => logs.push(message));
  assert.ok(tray);
  tray.setState('online', '水族箱 · 在线');
  tray.onMenu(() => { menuCalls += 1; });
  tray.notify('请登录小号 QQ');
  tray.dispose();
  tray.dispose();
  tray.setState('error', '水族箱 · 出错');

  assert.deepEqual(logs, [
    '托盘状态：online；水族箱 · 在线',
    '托盘菜单回调已注册（空实现）。',
    '托盘通知（空实现）：请登录小号 QQ',
    '托盘空实现已释放。',
  ]);
  assert.equal(menuCalls, 0);
});

test('host 状态绑定更新 tooltip，仅在进入等待登录态时通知一次并可清理', async () => {
  const imported = await import('../src/host/tray.ts').catch(() => undefined);
  assert.ok(imported, 'host tray module should exist');
  const api = imported as unknown as {
    bindHostTray?: (
      host: Host,
      tray: {
        setState: (state: HostStatus, tooltip: string) => void;
        onMenu: (handler: (action: string) => void) => void;
        notify: (text: string) => void;
        dispose: () => void;
      },
      onMenu: (action: string) => void,
    ) => () => void;
  };
  assert.equal(typeof api.bindHostTray, 'function');

  let currentStatus: HostStatus = 'starting';
  const listeners = new Set<(status: HostStatus, message?: string) => void>();
  const host: Host = {
    async start() {},
    async stop() {},
    status: () => currentStatus,
    onStatus(callback) {
      listeners.add(callback);
      callback(currentStatus);
      return () => listeners.delete(callback);
    },
  };
  const events: string[] = [];
  let menuHandler: ((action: string) => void) | undefined;
  const tray = {
    setState: (status: HostStatus, tooltip: string) => events.push(`state:${status}:${tooltip}`),
    onMenu: (handler: (action: string) => void) => {
      events.push('menu:registered');
      menuHandler = handler;
    },
    notify: (text: string) => events.push(`notify:${text}`),
    dispose: () => events.push('dispose'),
  };
  const actions: string[] = [];
  const dispose = api.bindHostTray?.(host, tray, (action) => actions.push(action));
  assert.ok(dispose);

  const publish = (status: HostStatus): void => {
    currentStatus = status;
    for (const listener of listeners) listener(status);
  };
  publish('waiting_qq_login');
  publish('waiting_qq_login');
  publish('online');
  publish('waiting_qq_login');
  menuHandler?.('open-qq');
  dispose();
  const beforeLateStatus = events.length;
  publish('error');

  assert.deepEqual(events, [
    'menu:registered',
    'state:starting:水族箱 · 启动中',
    'state:waiting_qq_login:水族箱 · 等待小号登录',
    'notify:请登录小号 QQ',
    'state:waiting_qq_login:水族箱 · 等待小号登录',
    'state:online:水族箱 · 在线',
    'state:waiting_qq_login:水族箱 · 等待小号登录',
    'notify:请登录小号 QQ',
    'dispose',
  ]);
  assert.equal(beforeLateStatus, events.length);
  assert.deepEqual(actions, ['open-qq']);
});
