import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { TrayOptions } from '@trayjs/trayjs';
import type { HostStatus } from '../src/host/types.ts';
import { createTrayJsAdapter, type TrayJsAdapterOptions } from '../src/host/tray.ts';

interface FakeTrayHandle {
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
  setIcon(icon: { png: string; ico: string }): void;
  setTooltip(text: string): void;
  quit(): void;
}

class FakeTray implements FakeTrayHandle {
  static instances: FakeTray[] = [];
  readonly iconUpdates: Array<{ png: string; ico: string }> = [];
  readonly tooltips: string[] = [];
  readonly closeListeners: Array<(code: number | null) => void> = [];
  readonly readyListeners: Array<() => void> = [];
  readonly options: TrayOptions;
  tooltipError: Error | undefined;
  quitCalls = 0;

  constructor(options: TrayOptions) {
    this.options = options;
    FakeTray.instances.push(this);
  }

  on(event: 'close' | 'ready', listener: ((code: number | null) => void) | (() => void)): this {
    if (event === 'close') this.closeListeners.push(listener as (code: number | null) => void);
    else this.readyListeners.push(listener as () => void);
    return this;
  }

  setIcon(icon: { png: string; ico: string }): void {
    this.iconUpdates.push(icon);
  }

  setTooltip(text: string): void {
    if (this.tooltipError) {
      const error = this.tooltipError;
      this.tooltipError = undefined;
      throw error;
    }
    this.tooltips.push(text);
  }

  quit(): void {
    this.quitCalls += 1;
  }

  closeWithCode(code: number | null): void {
    for (const listener of this.closeListeners) listener(code);
  }

  becomeReady(): void {
    if (this.options.icon) this.setIcon(this.options.icon);
    for (const listener of this.readyListeners) listener();
  }
}

const assetsDirectory = path.resolve('assets', 'tray');

function createTestTray(options: Partial<TrayJsAdapterOptions> = {}) {
  return createTrayJsAdapter(FakeTray, {
    assetsDirectory,
    qqExePath: '',
    isAllMuted: () => false,
    logError: () => {},
    ...options,
  });
}

test('真实托盘适配器按 host 状态映射三色 ICO 与 tooltip', async () => {
  FakeTray.instances = [];

  const tray = createTestTray({
    assetsDirectory,
    qqExePath: '',
    isAllMuted: () => false,
    logError: () => {},
  });
  const native = FakeTray.instances[0];
  assert.ok(native);
  assert.equal(native.options.icon?.ico, path.join(assetsDirectory, 'yellow.ico'));
  assert.equal(native.options.tooltip, '水族箱 · 启动中');

  const states: Array<[HostStatus, string]> = [
    ['waiting_qq_login', '水族箱 · 等待小号登录'],
    ['online', '水族箱 · 在线'],
    ['error', '水族箱 · 出错'],
  ];
  for (const [status, tooltip] of states) tray.setState(status, tooltip);

  assert.deepEqual(native.iconUpdates.map((icon) => path.basename(icon.ico)), [
    'yellow.ico',
    'teal.ico',
    'red.ico',
  ]);
  assert.deepEqual(native.tooltips, [
    '水族箱 · 等待小号登录',
    '水族箱 · 在线',
    '水族箱 · 出错',
  ]);
  tray.dispose();
});

test('helper ready 后重新应用启动期间的最新状态，避免回退到初始图标', () => {
  FakeTray.instances = [];
  const tray = createTestTray();
  const native = FakeTray.instances[0];
  assert.ok(native);

  tray.setState('error', '水族箱 · 出错');
  native.becomeReady();

  assert.deepEqual(native.iconUpdates.map((icon) => path.basename(icon.ico)), [
    'red.ico',
    'yellow.ico',
    'red.ico',
  ]);
  assert.equal(native.tooltips.at(-1), '水族箱 · 出错');
  tray.dispose();
});

test('helper ready 保留启动期间的登录提示 tooltip', () => {
  FakeTray.instances = [];
  const tray = createTestTray();
  const native = FakeTray.instances[0];
  assert.ok(native);

  tray.setState('waiting_qq_login', '水族箱 · 等待小号登录');
  tray.notify('请登录小号 QQ');
  native.becomeReady();

  assert.equal(native.tooltips.at(-1), '水族箱 · 请登录小号 QQ');
  tray.dispose();
});

test('真实托盘菜单反映闭嘴状态、QQ 路径可用性并转发菜单动作', async () => {
  FakeTray.instances = [];

  let allMuted = false;
  const tray = createTestTray({
    assetsDirectory,
    qqExePath: '',
    isAllMuted: () => allMuted,
    logError: () => {},
  });
  const native = FakeTray.instances[0];
  assert.ok(native);
  const menu = await native.options.onMenuRequested?.();
  assert.deepEqual(menu, [
    { id: 'status', title: '水族箱 · 启动中', enabled: false },
    { id: 'separator-before-actions', separator: true },
    { id: 'open-console', title: '打开控制台' },
    { id: 'open-qq', title: '打开 QQ', enabled: false },
    { id: 'mute-all', title: '全部闭嘴' },
    { id: 'restart-snowluma', title: '重启 SnowLuma' },
    { id: 'separator-before-quit', separator: true },
    { id: 'quit', title: '退出' },
  ]);

  const actions: string[] = [];
  tray.onMenu((action) => {
    actions.push(action);
  });
  native.options.onClicked?.('open-qq');
  native.options.onClicked?.('open-console');
  native.options.onClicked?.('mute-all');
  allMuted = true;
  assert.deepEqual((await native.options.onMenuRequested?.())?.[4], { id: 'unmute-all', title: '恢复说话' });
  native.options.onClicked?.('unmute-all');
  native.options.onClicked?.('restart-snowluma');
  native.options.onClicked?.('quit');

  assert.deepEqual(actions, ['open-console', 'mute-all', 'unmute-all', 'restart-snowluma', 'quit']);
  tray.dispose();
});

test('无系统通知 API 时仅以 tooltip 显示提醒', async () => {
  FakeTray.instances = [];

  const tray = createTestTray({
    assetsDirectory,
    qqExePath: '',
    isAllMuted: () => false,
    logError: () => {},
  });
  const native = FakeTray.instances[0];
  assert.ok(native);

  tray.notify('请登录小号 QQ');

  assert.deepEqual(native.tooltips, ['水族箱 · 请登录小号 QQ']);
  tray.dispose();
});

test('托盘辅助进程意外退出只记录错误、不重建且不影响 host 调用方', async () => {
  FakeTray.instances = [];

  const errors: string[] = [];
  const actions: string[] = [];
  const tray = createTestTray({
    assetsDirectory,
    qqExePath: 'C:/fixture/QQ.exe',
    isAllMuted: () => false,
    logError: (message) => errors.push(message),
  });
  const native = FakeTray.instances[0];
  assert.ok(native);
  tray.onMenu((action) => {
    actions.push(action);
  });
  tray.setState('online', '水族箱 · 在线');
  const tooltipsBeforeExit = native.tooltips.length;
  const iconsBeforeExit = native.iconUpdates.length;

  native.closeWithCode(23);
  native.closeWithCode(23);
  tray.setState('error', '水族箱 · 出错');
  tray.notify('稍后重试');
  native.options.onClicked?.('open-console');

  assert.deepEqual(errors, ['托盘辅助进程意外退出（code=23）；Aquarium 继续运行。']);
  assert.equal(native.tooltips.length, tooltipsBeforeExit);
  assert.equal(native.iconUpdates.length, iconsBeforeExit);
  assert.deepEqual(actions, []);
  assert.equal(FakeTray.instances.length, 1);
  tray.dispose();
  assert.equal(native.quitCalls, 0);
});

test('正常 dispose 只请求一次 helper 退出且不记录异常', async () => {
  FakeTray.instances = [];

  const errors: string[] = [];
  const tray = createTestTray({
    assetsDirectory,
    qqExePath: '',
    isAllMuted: () => false,
    logError: (message) => errors.push(message),
  });
  const native = FakeTray.instances[0];
  assert.ok(native);

  tray.dispose();
  tray.dispose();
  native.closeWithCode(0);

  assert.equal(native.quitCalls, 1);
  assert.deepEqual(errors, []);
});

test('异步菜单动作拒绝时记录错误并保留主进程', async () => {
  FakeTray.instances = [];

  const errors: string[] = [];
  const tray = createTestTray({
    assetsDirectory,
    qqExePath: '',
    isAllMuted: () => false,
    logError: (message) => errors.push(message),
  });
  const native = FakeTray.instances[0];
  assert.ok(native);
  tray.onMenu(async () => {
    throw new Error('fixture failure');
  });

  native.options.onClicked?.('open-console');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, ['托盘菜单动作失败（open-console）：Error']);
  tray.dispose();
});

test('托盘 API 通信失败后停用适配器并记录准确错误', () => {
  FakeTray.instances = [];
  const errors: string[] = [];
  const tray = createTestTray({ logError: (message) => errors.push(message) });
  const native = FakeTray.instances[0];
  assert.ok(native);
  native.tooltipError = new Error('synthetic helper pipe failure');

  tray.setState('online', '水族箱 · 在线');
  native.closeWithCode(23);
  tray.notify('不可用');

  assert.deepEqual(errors, ['托盘辅助进程通信失败（Error）；Aquarium 继续运行。']);
  assert.deepEqual(native.tooltips, []);
  tray.dispose();
  assert.equal(native.quitCalls, 0);
});
