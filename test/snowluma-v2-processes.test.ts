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

test('same PID unknown identity warns once per consecutive unknown streak', async () => {
  let resolved = false;
  let unknownAgain = false;
  const warnings: string[] = [];
  const debug: string[] = [];
  const loaded: number[] = [];
  const process = { pid: 901, name: 'QQ.exe', status: 'available', loggedIn: false, uin: '10001' };
  const watcher = createQqWatcher({
    targetUins: [10001],
    scanIntervalSec: 5,
    getClient: () => ({
      listProcesses: async () => [resolved && !unknownAgain ? { ...process, loggedIn: true } : process],
      load: async (pid: number) => {
        loaded.push(pid);
        return { success: true };
      },
    }) as never,
    log: (message) => warnings.push(message),
    debug: (message) => debug.push(message),
  });

  await watcher.scanOnce();
  await watcher.scanOnce();
  assert.equal(warnings.length, 1);
  assert.equal(debug.length, 1);

  resolved = true;
  await watcher.scanOnce();
  assert.deepEqual(loaded, [901]);

  unknownAgain = true;
  await watcher.scanOnce();
  assert.equal(warnings.length, 1);
  assert.deepEqual(loaded, [901]);
});
