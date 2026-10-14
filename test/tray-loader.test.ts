import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createWindowsTray } from '../src/host/tray.ts';

class FakeWorker extends EventEmitter {
  readonly messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  emitMessage(message: unknown): void {
    this.emit('message', message);
  }
}

test('Windows tray worker proxies state, live menu state, callbacks, and disposal', async () => {
  const worker = new FakeWorker();
  let factoryCalls = 0;
  let workerUrl: URL | undefined;
  let workerOptions: { workerData?: unknown } | undefined;
  let allMuted = true;
  const tray = await createWindowsTray({
    assetsDirectory: 'fixture-assets',
    qqExePath: '',
    isAllMuted: () => allMuted,
    logError: () => {},
  }, (url, options) => {
    factoryCalls += 1;
    workerUrl = url;
    workerOptions = options;
    return worker;
  });

  assert.equal(factoryCalls, 1);
  assert.equal(workerUrl?.pathname.endsWith('/src/host/windows/tray-worker.ts'), true);
  assert.deepEqual(workerOptions?.workerData, { assetsDirectory: 'fixture-assets', qqExePath: '' });

  tray.setState('online', '水族箱 · 在线');
  tray.notify('请登录小号 QQ');
  worker.emitMessage({ type: 'get-all-muted', requestId: 7 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(worker.messages, [
    { type: 'set-state', state: 'online', tooltip: '水族箱 · 在线' },
    { type: 'notify', text: '请登录小号 QQ' },
    { type: 'all-muted-response', requestId: 7, allMuted: true },
  ]);

  const actions: string[] = [];
  tray.onMenu((action) => { actions.push(action); });
  worker.emitMessage({ type: 'clicked', action: 'open-console' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(actions, ['open-console']);

  allMuted = false;
  worker.emitMessage({ type: 'get-all-muted', requestId: 8 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(worker.messages.at(-1), { type: 'all-muted-response', requestId: 8, allMuted: false });

  tray.dispose();
  assert.deepEqual(worker.messages.at(-1), { type: 'dispose' });
});

test('worker startup failure is reported, contained, and never retried', async () => {
  const worker = new FakeWorker();
  const errors: string[] = [];
  let factoryCalls = 0;
  const tray = await createWindowsTray({
    assetsDirectory: 'fixture-assets',
    qqExePath: '',
    isAllMuted: () => false,
    logError: (message) => errors.push(message),
  }, () => {
    factoryCalls += 1;
    return worker;
  });

  worker.emit('error', new Error('synthetic tray worker failure'));
  tray.setState('error', '水族箱 · 出错');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(factoryCalls, 1);
  assert.deepEqual(errors, ['托盘 worker 出错（Error）；Aquarium 继续运行。']);
  assert.deepEqual(worker.messages, []);
  tray.dispose();
});

test('worker-reported helper exit is logged once and the tray is never recreated', async () => {
  const worker = new FakeWorker();
  const errors: string[] = [];
  let factoryCalls = 0;
  const tray = await createWindowsTray({
    assetsDirectory: 'fixture-assets',
    qqExePath: '',
    isAllMuted: () => false,
    logError: (message) => errors.push(message),
  }, () => {
    factoryCalls += 1;
    return worker;
  });

  worker.emitMessage({
    type: 'adapter-error',
    message: '托盘辅助进程意外退出（code=17）；Aquarium 继续运行。',
  });
  worker.emitMessage({ type: 'adapter-error', message: 'duplicate failure' });
  tray.setState('error', '水族箱 · 出错');

  assert.equal(factoryCalls, 1);
  assert.deepEqual(errors, ['托盘辅助进程意外退出（code=17）；Aquarium 继续运行。']);
  assert.deepEqual(worker.messages, []);
  tray.dispose();
});
