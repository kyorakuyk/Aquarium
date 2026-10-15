import assert from 'node:assert/strict';
import test from 'node:test';
import { createQqWatcher } from '../src/host/windows/qq-watcher.ts';

test('成功注入后通知宿主立即重试匹配账号', async () => {
  const injectedUins: number[] = [];
  const client = {
    listProcesses: async () => [{ pid: 123, name: 'QQ.exe' }],
    probeLogin: async () => ({ port: 4301, uin: '10001', identityKnown: true }),
    load: async () => ({ success: true }),
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => client as never,
    onInjected: (uin) => injectedUins.push(uin),
    log: () => {},
  });

  await watcher.scanOnce();
  await watcher.scanOnce();

  assert.deepEqual(injectedUins, [10001]);
});
