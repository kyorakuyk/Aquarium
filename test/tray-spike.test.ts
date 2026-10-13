import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { Icon, MenuItem, TrayOptions } from '@trayjs/trayjs';
import { createTraySpike } from '../src/spike/tray.ts';

class FakeTray {
  static instances: FakeTray[] = [];
  readonly iconUpdates: Icon[] = [];
  readonly listeners = new Map<string, Array<(code: number | null) => void>>();
  readonly options: TrayOptions;
  quitCalls = 0;

  constructor(options: TrayOptions = {}) {
    this.options = options;
    FakeTray.instances.push(this);
  }

  setIcon(icon: Icon): void {
    this.iconUpdates.push(icon);
  }

  setTooltip(_tooltip: string): void {}

  setMenu(_items: MenuItem[]): void {}

  quit(): void {
    this.quitCalls += 1;
    this.closeWithCode(0);
  }

  closeWithCode(code: number | null): void {
    for (const listener of this.listeners.get('close') ?? []) listener(code);
  }

  on(event: string, listener: (code: number | null) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }
}

test('托盘 spike 在显式创建时使用青色图标和固定菜单', async () => {
  FakeTray.instances = [];
  const exits: number[] = [];
  const assetsDirectory = path.resolve('assets', 'tray');
  const result = createTraySpike(FakeTray, assetsDirectory, (code) => exits.push(code));

  assert.equal(FakeTray.instances.length, 1);
  assert.equal(result.tray.options.tooltip, '水族箱');
  assert.equal(result.tray.options.icon?.ico, path.join(assetsDirectory, 'teal.ico'));
  assert.equal(exits.length, 0);
  assert.deepEqual(await result.tray.options.onMenuRequested?.(), [
    { id: 'status', title: '状态：测试中', enabled: false },
    { id: 'switch-color', title: '切换颜色' },
    { id: 'quit', title: '退出' },
  ]);
});

test('切换颜色按青、黄、红循环并更新图标', () => {
  FakeTray.instances = [];
  const result = createTraySpike(FakeTray, path.resolve('assets', 'tray'), () => {});
  const click = result.tray.options.onClicked;
  assert.ok(click);

  click('switch-color');
  click('switch-color');
  click('switch-color');

  assert.deepEqual(result.tray.iconUpdates.map((icon) => path.basename(icon.ico)), [
    'yellow.ico',
    'red.ico',
    'teal.ico',
  ]);
});

test('退出菜单关闭托盘并通知 spike 退出', () => {
  FakeTray.instances = [];
  const exits: number[] = [];
  const result = createTraySpike(FakeTray, path.resolve('assets', 'tray'), (code) => exits.push(code));
  const click = result.tray.options.onClicked;
  assert.ok(click);

  click('quit');

  assert.equal(result.tray.quitCalls, 1);
  assert.deepEqual(exits, [0]);
});

test('helper 意外关闭时 spike 以失败码退出', () => {
  FakeTray.instances = [];
  const exits: number[] = [];
  createTraySpike(FakeTray, path.resolve('assets', 'tray'), (code) => exits.push(code));

  FakeTray.instances[0]?.closeWithCode(0);

  assert.deepEqual(exits, [1]);
});
