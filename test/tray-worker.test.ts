import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import type { MenuItem, TrayOptions } from '@trayjs/trayjs';

interface FakeTrayHandle {
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
  setIcon(icon: { png: string; ico: string }): void;
  setTooltip(text: string): void;
  quit(): void;
}

class FakeTray implements FakeTrayHandle {
  static instances: FakeTray[] = [];
  readonly options: TrayOptions;
  readonly iconUpdates: Array<{ png: string; ico: string }> = [];
  readonly tooltips: string[] = [];
  private readonly closeListeners: Array<(code: number | null) => void> = [];
  private readonly readyListeners: Array<() => void> = [];
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

  setIcon(icon: { png: string; ico: string }): void { this.iconUpdates.push(icon); }
  setTooltip(text: string): void { this.tooltips.push(text); }
  quit(): void { this.quitCalls += 1; }

  becomeReady(): void {
    if (this.options.icon) this.setIcon(this.options.icon);
    for (const listener of this.readyListeners) listener();
  }

  closeWithCode(code: number | null): void {
    for (const listener of this.closeListeners) listener(code);
  }
}

class FakeWorkerPort extends EventEmitter {
  readonly messages: unknown[] = [];
  closeCalls = 0;
  failPosts = false;

  postMessage(message: unknown): void {
    if (this.failPosts) throw new Error('synthetic port failure');
    this.messages.push(message);
  }
  close(): void { this.closeCalls += 1; }
  receive(message: unknown): void { this.emit('message', message); }
  disconnect(): void { this.emit('close'); }
}

async function loadStartTrayWorker(): Promise<((
  TrayConstructor: new (options: TrayOptions) => FakeTrayHandle,
  port: FakeWorkerPort,
  workerData: { assetsDirectory: string; qqExePath: string },
) => void) | undefined> {
  let module: typeof import('../src/host/windows/tray-worker-runtime.ts');
  try {
    module = await import('../src/host/windows/tray-worker-runtime.ts');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
  return (module as unknown as {
    startTrayWorker?: (
      TrayConstructor: new (options: TrayOptions) => FakeTrayHandle,
      port: FakeWorkerPort,
      workerData: { assetsDirectory: string; qqExePath: string },
    ) => void;
  }).startTrayWorker;
}

test('tray worker applies latest host state, bridges live mute state and actions, and quits cleanly', async () => {
  FakeTray.instances = [];
  const startTrayWorker = await loadStartTrayWorker();
  assert.equal(typeof startTrayWorker, 'function');
  if (!startTrayWorker) return;

  const port = new FakeWorkerPort();
  startTrayWorker(FakeTray, port, { assetsDirectory: 'fixture-assets', qqExePath: '' });
  const native = FakeTray.instances[0];
  assert.ok(native);

  port.receive({ type: 'set-state', state: 'error', tooltip: '水族箱 · 出错' });
  native.becomeReady();
  assert.deepEqual(native.iconUpdates.map((icon) => path.basename(icon.ico)), [
    'red.ico',
    'yellow.ico',
    'red.ico',
  ]);
  assert.equal(native.tooltips.at(-1), '水族箱 · 出错');

  const menuPromise = native.options.onMenuRequested?.() as Promise<MenuItem[]>;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(port.messages, [{ type: 'get-all-muted', requestId: 1 }]);
  port.receive({ type: 'all-muted-response', requestId: 1, allMuted: true });
  const menu = await menuPromise;
  assert.deepEqual(menu[4], { id: 'unmute-all', title: '恢复说话' });

  native.options.onClicked?.('quit');
  assert.deepEqual(port.messages.at(-1), { type: 'clicked', action: 'quit' });
  port.receive({ type: 'dispose' });
  assert.equal(native.quitCalls, 1);
  assert.equal(port.closeCalls, 1);
});

test('tray worker reports unexpected helper exit to the parent without retrying', async () => {
  FakeTray.instances = [];
  const startTrayWorker = await loadStartTrayWorker();
  assert.equal(typeof startTrayWorker, 'function');
  if (!startTrayWorker) return;

  const port = new FakeWorkerPort();
  startTrayWorker(FakeTray, port, { assetsDirectory: 'fixture-assets', qqExePath: '' });
  const native = FakeTray.instances[0];
  assert.ok(native);

  native.closeWithCode(17);

  assert.deepEqual(port.messages, [
    { type: 'adapter-error', message: '托盘辅助进程意外退出（code=17）；Aquarium 继续运行。' },
  ]);
  assert.equal(port.closeCalls, 1);
  assert.equal(FakeTray.instances.length, 1);
});

test('tray worker disposes the native tray when its parent port fails', async () => {
  FakeTray.instances = [];
  const startTrayWorker = await loadStartTrayWorker();
  assert.equal(typeof startTrayWorker, 'function');
  if (!startTrayWorker) return;

  const port = new FakeWorkerPort();
  startTrayWorker(FakeTray, port, { assetsDirectory: 'fixture-assets', qqExePath: '' });
  const native = FakeTray.instances[0];
  assert.ok(native);
  port.failPosts = true;
  native.options.onClicked?.('open-console');

  assert.equal(native.quitCalls, 1);
  assert.equal(port.closeCalls, 1);
});

test('tray worker disposes the native tray and settles pending menu state when the parent disconnects', async () => {
  FakeTray.instances = [];
  const startTrayWorker = await loadStartTrayWorker();
  assert.equal(typeof startTrayWorker, 'function');
  if (!startTrayWorker) return;

  const port = new FakeWorkerPort();
  startTrayWorker(FakeTray, port, { assetsDirectory: 'fixture-assets', qqExePath: '' });
  const native = FakeTray.instances[0];
  assert.ok(native);
  const menuPromise = native.options.onMenuRequested?.() as Promise<MenuItem[]>;
  assert.deepEqual(port.messages, [{ type: 'get-all-muted', requestId: 1 }]);

  port.disconnect();

  const menuResolved = await Promise.race([
    menuPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(menuResolved, true);
  assert.equal(native.quitCalls, 1);
  assert.equal(port.closeCalls, 0);
});
