import assert from 'node:assert/strict';
import test from 'node:test';
import type { Host, HostStatus } from '../src/host/types.ts';
import { bindHostTray, type Tray, type TrayMenuAction, type TrayMenuHandler } from '../src/host/tray.ts';

test('host 状态绑定更新 tooltip，仅在进入等待登录态时通知一次并可清理', () => {
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
  let menuHandler: TrayMenuHandler | undefined;
  const tray: Tray = {
    setState(status, tooltip) {
      events.push(`state:${status}:${tooltip}`);
    },
    onMenu(handler) {
      events.push('menu:registered');
      menuHandler = handler;
    },
    notify(text) {
      events.push(`notify:${text}`);
    },
    dispose() {
      events.push('dispose');
    },
  };
  const actions: string[] = [];
  const dispose = bindHostTray(host, tray, (action: TrayMenuAction) => {
    actions.push(action);
  });

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

test('shutdown during lazy tray loading disposes the tray without binding host callbacks', async () => {
  const module = await import('../src/host/tray.ts');
  const bindHostTrayAfterLoad = (module as unknown as {
    bindHostTrayAfterLoad?: (options: {
      host: Host;
      loadTray: () => Promise<Tray>;
      shouldContinue: () => boolean;
      onMenu: TrayMenuHandler;
    }) => Promise<(() => void) | undefined>;
  }).bindHostTrayAfterLoad;
  assert.equal(typeof bindHostTrayAfterLoad, 'function');
  if (!bindHostTrayAfterLoad) return;

  let statusSubscriptions = 0;
  const host: Host = {
    async start() {},
    async stop() {},
    status: () => 'starting',
    onStatus() {
      statusSubscriptions += 1;
      return () => {};
    },
  };
  let disposeCalls = 0;
  const tray: Tray = {
    setState() {},
    onMenu() {},
    notify() {},
    dispose() { disposeCalls += 1; },
  };
  let releaseTray: ((value: Tray) => void) | undefined;
  let shouldContinue = true;
  const pendingBinding = bindHostTrayAfterLoad({
    host,
    loadTray: () => new Promise((resolve) => { releaseTray = resolve; }),
    shouldContinue: () => shouldContinue,
    onMenu: () => {},
  });

  shouldContinue = false;
  releaseTray?.(tray);

  assert.equal(await pendingBinding, undefined);
  assert.equal(disposeCalls, 1);
  assert.equal(statusSubscriptions, 0);
});
