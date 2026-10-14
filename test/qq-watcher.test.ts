import assert from 'node:assert/strict';
import test from 'node:test';
import { SnowLumaWebUIError } from '../src/host/windows/snowluma-webui.ts';
import { createQqWatcher } from '../src/host/windows/qq-watcher.ts';

const processInfo = {
  pid: 123,
  name: 'QQ.exe',
  path: '',
  injected: false,
  connected: false,
  loggedIn: false,
  uin: '0',
  status: 'available',
  error: '',
  method: '',
};

test('只对已识别为目标小号的 PID 注入一次', async () => {
  let loadCalls = 0;
  const client = {
    listProcesses: async () => [processInfo],
    probeLogin: async (pid: number) => {
      assert.equal(pid, 123);
      return { port: 4301, uin: '10001', identityKnown: true };
    },
    load: async (pid: number) => {
      assert.equal(pid, 123);
      loadCalls += 1;
      return { success: true, process: { ...processInfo, pid, injected: true, uin: '10001', status: 'loaded' } };
    },
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => client as never,
    log: () => {},
  });

  await watcher.scanOnce();
  await watcher.scanOnce();

  assert.equal(loadCalls, 1);
  assert.deepEqual([...watcher.injectedUins()], [10001]);
});

test('未知身份每轮重试，不匹配身份记为忽略，二者都不注入', async () => {
  const processes = [
    { ...processInfo, pid: 201 },
    { ...processInfo, pid: 202 },
  ];
  const probes = new Map<number, number>();
  let loadCalls = 0;
  const client = {
    listProcesses: async () => processes,
    probeLogin: async (pid: number) => {
      probes.set(pid, (probes.get(pid) ?? 0) + 1);
      return pid === 201
        ? { port: 4302, uin: '10001', identityKnown: false }
        : { port: 4303, uin: '20002', identityKnown: true };
    },
    load: async () => {
      loadCalls += 1;
      return { success: true };
    },
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => client as never,
    log: () => {},
  });

  await watcher.scanOnce();
  await watcher.scanOnce();

  assert.equal(probes.get(201), 2);
  assert.equal(probes.get(202), 1);
  assert.equal(loadCalls, 0);
  assert.deepEqual([...watcher.injectedUins()], []);
});

test('load 失败后下一轮重试，成功后不再重复加载', async () => {
  let probeCalls = 0;
  let loadCalls = 0;
  const client = {
    listProcesses: async () => [processInfo],
    probeLogin: async () => {
      probeCalls += 1;
      return { port: 4301, uin: '10001', identityKnown: true };
    },
    load: async () => {
      loadCalls += 1;
      return { success: loadCalls > 1 };
    },
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => client as never,
    log: () => {},
  });

  await watcher.scanOnce();
  assert.deepEqual([...watcher.injectedUins()], []);
  await watcher.scanOnce();
  await watcher.scanOnce();

  assert.equal(probeCalls, 2);
  assert.equal(loadCalls, 2);
  assert.deepEqual([...watcher.injectedUins()], [10001]);
});

test('进程列表中消失的 PID 被清理，后续重现时重新判定', async () => {
  let processes = [{ ...processInfo, pid: 321 }];
  let loadCalls = 0;
  const client = {
    listProcesses: async () => processes,
    probeLogin: async () => ({ port: 4321, uin: '10001', identityKnown: true }),
    load: async () => {
      loadCalls += 1;
      return { success: true };
    },
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => client as never,
    log: () => {},
  });

  await watcher.scanOnce();
  assert.deepEqual([...watcher.injectedUins()], [10001]);
  processes = [];
  await watcher.scanOnce();
  assert.deepEqual([...watcher.injectedUins()], []);
  processes = [{ ...processInfo, pid: 321 }];
  await watcher.scanOnce();

  assert.equal(loadCalls, 2);
  assert.deepEqual([...watcher.injectedUins()], [10001]);
});

test('每轮扫描结束后通知宿主重算连接状态', async () => {
  let scanNotifications = 0;
  const client = {
    listProcesses: async () => [],
    probeLogin: async () => null,
    load: async () => ({ success: false }),
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => client as never,
    onScan: () => { scanNotifications += 1; },
    log: () => {},
  });

  await watcher.scanOnce();

  assert.equal(scanNotifications, 1);
});

test('并发 start 只创建一个轮询计时器，stop 清理它', async () => {
  let releaseList: ((value: []) => void) | undefined;
  let intervalCalls = 0;
  let clearCalls = 0;
  const client = {
    listProcesses: async () => new Promise<[]>((resolve) => { releaseList = resolve; }),
    probeLogin: async () => null,
    load: async () => ({ success: false }),
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => client as never,
    setInterval: ((callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 5_000);
      intervalCalls += 1;
      return intervalCalls as never;
    }) as never,
    clearInterval: (() => { clearCalls += 1; }) as never,
    log: () => {},
  });

  const firstStart = watcher.start();
  const secondStart = watcher.start();
  await Promise.resolve();
  releaseList?.([]);
  await Promise.all([firstStart, secondStart]);
  watcher.stop();

  assert.equal(intervalCalls, 1);
  assert.equal(clearCalls, 1);
});

test('stop 在身份探测返回后阻止启动新的注入请求', async () => {
  let releaseProbe: ((value: { port: number; uin: string; identityKnown: boolean }) => void) | undefined;
  let probeStartedResolve: (() => void) | undefined;
  const probeStarted = new Promise<void>((resolve) => { probeStartedResolve = resolve; });
  let loadCalls = 0;
  const client = {
    listProcesses: async () => [processInfo],
    probeLogin: async () => {
      probeStartedResolve?.();
      return new Promise<{ port: number; uin: string; identityKnown: boolean }>((resolve) => { releaseProbe = resolve; });
    },
    load: async () => {
      loadCalls += 1;
      return { success: true };
    },
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => client as never,
    log: () => {},
  });

  const scan = watcher.scanOnce();
  await probeStarted;
  watcher.stop();
  releaseProbe?.({ port: 4301, uin: '10001', identityKnown: true });
  await scan;

  assert.equal(loadCalls, 0);
});

test('401 重登录仍失败时通知宿主进入 error，而不是按普通扫描错误重试', async () => {
  let fatalError: unknown;
  const client = {
    listProcesses: async () => {
      throw new SnowLumaWebUIError('authorization failed', 401, false, 'http');
    },
    probeLogin: async () => null,
    load: async () => ({ success: false }),
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => client as never,
    onFatalError: (error: unknown) => { fatalError = error; },
    log: () => {},
  });

  await watcher.scanOnce();

  assert.ok(fatalError instanceof SnowLumaWebUIError);
  assert.equal(fatalError.status, 401);
});
