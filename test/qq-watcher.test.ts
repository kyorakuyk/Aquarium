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
    listProcesses: async () => [{ ...processInfo, loggedIn: true, uin: '10001' }],
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
    { ...processInfo, pid: 201, uin: '0', account: undefined },
    { ...processInfo, pid: 202, loggedIn: true, uin: '20002' },
  ];
  let loadCalls = 0;
  const client = {
    listProcesses: async () => processes,
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

  assert.equal(loadCalls, 0);
  assert.deepEqual([...watcher.injectedUins()], []);
});

test('已在线目标账号首轮触发回调、不调用 load，后续扫描不重复回调', async () => {
  let loadCalls = 0;
  const injectedUins: number[] = [];
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => ({
      listProcesses: async () => [{ ...processInfo, status: 'online', loggedIn: true, uin: '10001' }],
      load: async () => { loadCalls += 1; return { success: true }; },
    }) as never,
    onInjected: (uin) => injectedUins.push(uin),
  });

  await watcher.scanOnce();
  assert.deepEqual(injectedUins, [10001]);
  assert.equal(loadCalls, 0);

  await watcher.scanOnce();
  assert.deepEqual(injectedUins, [10001]);
  assert.equal(loadCalls, 0);
});

test('load 失败后下一轮重试，成功后不再重复加载', async () => {
  let loadCalls = 0;
  const client = {
    listProcesses: async () => [{ ...processInfo, loggedIn: true, uin: '10001' }],
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

  assert.equal(loadCalls, 2);
  assert.deepEqual([...watcher.injectedUins()], [10001]);
});

test('进程列表中消失的 PID 被清理，后续重现时重新判定', async () => {
  let processes = [{ ...processInfo, pid: 321, loggedIn: true, uin: '10001' }];
  let loadCalls = 0;
  const client = {
    listProcesses: async () => processes,
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
  processes = [{ ...processInfo, pid: 321, loggedIn: true, uin: '10001' }];
  await watcher.scanOnce();

  assert.equal(loadCalls, 2);
  assert.deepEqual([...watcher.injectedUins()], [10001]);
});

test('每轮扫描结束后通知宿主重算连接状态', async () => {
  let scanNotifications = 0;
  const client = {
    listProcesses: async () => [],
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

test('等待小号登录时未知身份只 WARN 首次，在线账号跳过，连接后恢复配置间隔', async () => {
  let processes = [
    { ...processInfo, pid: 301, uin: '0', account: undefined },
    { ...processInfo, pid: 302, loggedIn: true, uin: '20002' },
    { ...processInfo, pid: 303, loggedIn: true, uin: '10001' },
    { ...processInfo, pid: 304, status: 'online', loggedIn: true, uin: '10001' },
  ];
  const debugMessages: string[] = [];
  const warningMessages: string[] = [];
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  let nextId = 1;
  let waitingForLogin = true;
  let scanCount = 0;
  const client = {
    listProcesses: async () => processes,
    load: async () => ({ success: true }),
  };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getScanIntervalSec: () => waitingForLogin ? 2 : 5,
    getClient: () => client as never,
    onScan: () => {
      scanCount += 1;
      if (scanCount === 2) waitingForLogin = false;
    },
    debug: (message: string) => debugMessages.push(message),
    log: (message: string) => warningMessages.push(message),
    setInterval: ((callback: () => void, delay: number) => {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id as never;
    }) as never,
    clearInterval: ((timer: number) => { intervals.delete(timer); }) as never,
  });

  await watcher.start();
  assert.deepEqual([...intervals.values()].map((timer) => timer.delay), [2_000]);
  assert.deepEqual(warningMessages, ['QQ 目标进程 PID 301 身份未知；下一轮将重试。']);
  assert.equal(debugMessages.filter((message) => message.includes('PID 301')).length, 0);
  assert.deepEqual([...watcher.injectedUins()], [10001]);

  processes = [processes[0]!, processes[1]!, processes[2]!];
  [...intervals.values()][0]?.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual([...intervals.values()].map((timer) => timer.delay), [5_000]);
  assert.equal(warningMessages.length, 1);
  assert.ok(debugMessages.some((message) => message.includes('PID 301 身份仍未知')));
  watcher.stop();
  assert.equal(intervals.size, 0);
});

test('stop 在 process list 返回后阻止新的注入请求', async () => {
  let releaseList: ((value: typeof processInfo[]) => void) | undefined;
  let listStartedResolve: (() => void) | undefined;
  const listStarted = new Promise<void>((resolve) => { listStartedResolve = resolve; });
  let loadCalls = 0;
  const client = {
    listProcesses: async () => new Promise<typeof processInfo[]>((resolve) => {
      listStartedResolve?.();
      releaseList = resolve;
    }),
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
  await listStarted;
  watcher.stop();
  releaseList?.([{ ...processInfo, loggedIn: true, uin: '10001' }]);
  await scan;

  assert.equal(loadCalls, 0);
});

test('401 重登录仍失败时通知宿主进入 error，而不是按普通扫描错误重试', async () => {
  let fatalError: unknown;
  const client = {
    listProcesses: async () => {
      throw new SnowLumaWebUIError('authorization failed', 401, false, 'http');
    },

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
