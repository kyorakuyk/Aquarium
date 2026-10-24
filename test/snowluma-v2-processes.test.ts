import assert from 'node:assert/strict';
import test from 'node:test';
import { createSnowLumaWebUIClient } from '../src/host/windows/snowluma-webui.ts';
import { createQqWatcher } from '../src/host/windows/qq-watcher.ts';

const password = 'test-only-snowluma-password';
const token = 'test-only-snowluma-token';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(input.toString()).pathname;
}

test('v2.0.3 process list supplies identity directly and no probe endpoint is requested', async () => {
  const paths: string[] = [];
  const processes = [{
    pid: 812,
    name: 'QQ.exe',
    status: 'online',
    loggedIn: true,
    uin: 10001,
    account: { uin: 10001, nickname: 'fixture' },
  }];
  const client = createSnowLumaWebUIClient({
    baseUrl: 'http://127.0.0.1:5099',
    password,
    fetch: (async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      paths.push(path);
      if (path === '/api/login') return jsonResponse({ success: true, token, mustChangePassword: false });
      if (path === '/api/processes') return jsonResponse({ list: processes });
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch,
  });

  assert.deepEqual(await client.listProcesses(), processes);
  assert.deepEqual(paths, ['/api/login', '/api/processes']);
});

test('watcher prefers logged-in top-level uin, falls back to account uin, and skips online processes', async () => {
  const processes = [
    { pid: 801, name: 'QQ.exe', status: 'available', loggedIn: true, uin: '10001', account: { uin: '20002' } },
    { pid: 802, name: 'QQ.exe', status: 'available', loggedIn: false, uin: '10001', account: { uin: '10001' } },
    { pid: 803, name: 'QQ.exe', status: 'online', loggedIn: true, uin: '10001', account: { uin: '10001' } },
  ];
  const loaded: number[] = [];
  const injected: number[] = [];
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => ({
      listProcesses: async () => processes,
      load: async (pid: number) => {
        loaded.push(pid);
        return { success: true };
      },
    }) as never,
    onInjected: (uin) => injected.push(uin),
  });

  await watcher.scanOnce();

  assert.deepEqual(loaded, [801, 802]);
  assert.deepEqual(injected, [10001, 10001, 10001]);
  assert.deepEqual([...watcher.injectedUins()], [10001]);
});

test('online status with a matching identity is already loaded and is not loaded again', async () => {
  let loadCalls = 0;
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => ({
      listProcesses: async () => [{ pid: 850, name: 'QQ.exe', status: 'online', loggedIn: true, uin: '10001' }],
      load: async () => { loadCalls += 1; return { success: true }; },
    }) as never,
  });

  await watcher.scanOnce();

  assert.equal(loadCalls, 0);
  assert.deepEqual([...watcher.injectedUins()], [10001]);
});

test('same PID unknown identity resets after absence and still injects when resolved', async () => {
  let resolved = false;
  let present = true;
  let now = 0;
  const warnings: string[] = [];
  const debug: string[] = [];
  const loaded: number[] = [];
  const injected: number[] = [];
  const process = { pid: 901, name: 'QQ.exe', status: 'available', loggedIn: false, uin: '10001' };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => ({
      listProcesses: async () => present ? [resolved ? { ...process, loggedIn: true } : process] : [],
      load: async (pid: number) => {
        loaded.push(pid);
        return { success: true };
      },
    }) as never,
    log: (message) => warnings.push(message),
    debug: (message) => debug.push(message),
    now: () => now,
    onInjected: (uin) => injected.push(uin),
  });

  await watcher.scanOnce();
  now = 5_000;
  await watcher.scanOnce();
  assert.deepEqual(warnings, ['QQ 目标进程 PID 901 身份未知（已 0 秒 / 1 轮）；下一轮将重试。']);
  assert.deepEqual(debug, []);

  present = false;
  now = 120_000;
  await watcher.scanOnce();
  present = true;
  now = 125_000;
  await watcher.scanOnce();
  assert.deepEqual(warnings, [
    'QQ 目标进程 PID 901 身份未知（已 0 秒 / 1 轮）；下一轮将重试。',
    'QQ 目标进程 PID 901 身份未知（已 0 秒 / 1 轮）；下一轮将重试。',
  ]);

  resolved = true;
  now = 130_000;
  await watcher.scanOnce();
  assert.deepEqual(loaded, [901]);
  assert.deepEqual(injected, [10001]);
});

test('unknown identity logs at elapsed milestones and then hourly without changing scans', async () => {
  let now = 0;
  const warnings: string[] = [];
  const debug: string[] = [];
  const process = { pid: 902, name: 'QQ.exe', status: 'available', loggedIn: false, uin: '10001' };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => ({
      listProcesses: async () => [process],
      load: async () => ({ success: true }),
    }) as never,
    log: (message) => warnings.push(message),
    debug: (message) => debug.push(message),
    now: () => now,
  });

  for (let round = 0; round < 100; round += 1) {
    now = round * 5_000;
    await watcher.scanOnce();
  }

  assert.equal(warnings.length, 1);
  assert.equal(debug.length, 2);
  assert.deepEqual(debug, [
    'QQ 目标进程 PID 902 身份仍未知（已 1 分钟 / 13 轮）；下一轮继续重试。',
    'QQ 目标进程 PID 902 身份仍未知（已 5 分钟 / 61 轮）；下一轮继续重试。',
  ]);

  now = 30 * 60_000;
  await watcher.scanOnce();
  now = 90 * 60_000;
  await watcher.scanOnce();
  now = 150 * 60_000;
  await watcher.scanOnce();
  assert.deepEqual(debug, [
    'QQ 目标进程 PID 902 身份仍未知（已 1 分钟 / 13 轮）；下一轮继续重试。',
    'QQ 目标进程 PID 902 身份仍未知（已 5 分钟 / 61 轮）；下一轮继续重试。',
    'QQ 目标进程 PID 902 身份仍未知（已 30 分钟 / 101 轮）；下一轮继续重试。',
    'QQ 目标进程 PID 902 身份仍未知（已 1 小时 30 分钟 / 102 轮）；下一轮继续重试。',
    'QQ 目标进程 PID 902 身份仍未知（已 2 小时 30 分钟 / 103 轮）；下一轮继续重试。',
  ]);
});
