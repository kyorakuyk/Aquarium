import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWindowsHost } from '../src/host/windows/host.ts';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];

  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal);
    queueMicrotask(() => {
      this.emit('exit', 0, null);
      this.emit('close', 0, null);
    });
    return true;
  }
}

function createFixture(): { root: string; snowlumaDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aquarium-windows-host-'));
  const snowlumaDir = path.join(root, 'SnowLuma');
  mkdirSync(path.join(snowlumaDir, 'config'), { recursive: true });
  writeFileSync(path.join(snowlumaDir, 'index.mjs'), '', 'utf8');
  writeFileSync(path.join(snowlumaDir, 'config', 'runtime.json'), JSON.stringify({ hookAutoLoad: false }), 'utf8');
  return { root, snowlumaDir };
}

test('host 在目标 PID 注入后等待适配器在线；退出只停止 SnowLuma，不关 QQ', async () => {
  const fixture = createFixture();
  const child = new FakeChild();
  const adapterStatuses = new Map<number, 'connecting' | 'online' | 'offline'>([[10001, 'connecting']]);
  const hostStatuses: string[] = [];
  let intervalCallback: (() => void) | undefined;
  let clearIntervalCalls = 0;
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
  const host = createWindowsHost({
    accounts: [{ uin: 10001, snowlumaDir: fixture.snowlumaDir }],
    settings: { startSnowLuma: true, scanIntervalSec: 5 },
    password: 'unit-test-password-only',
    logDirectory: path.join(fixture.root, 'logs'),
    getAdapterStatus: (uin) => adapterStatuses.get(uin),
    spawnProcess: (() => child) as never,
    setInterval: ((callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 5_000);
      intervalCallback = callback;
      return 1;
    }) as never,
    clearInterval: (() => { clearIntervalCalls += 1; }) as never,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === '/api/login') {
        return new Response(JSON.stringify({ success: true, token: 'unit-test-session', mustChangePassword: false }));
      }
      if (url.pathname === '/api/processes') return new Response(JSON.stringify({ list: [processInfo] }));
      if (url.pathname === '/api/processes/123/probe-login') {
        return new Response(JSON.stringify({ info: { port: 4301, uin: '10001', identityKnown: true } }));
      }
      if (url.pathname === '/api/processes/123/load') {
        return new Response(JSON.stringify({ success: true, process: { ...processInfo, injected: true, status: 'loaded' } }));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch,
    log: () => {},
  });
  host.onStatus((status) => hostStatuses.push(status));

  try {
    await host.start();
    assert.equal(host.status(), 'waiting_qq_login');
    adapterStatuses.set(10001, 'online');
    intervalCallback?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(host.status(), 'online');
    let lateSubscriptionStatus: string | undefined;
    host.onStatus((status) => { lateSubscriptionStatus = status; });
    assert.equal(lateSubscriptionStatus, 'online');

    await host.stop();
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(clearIntervalCalls, 1);
    assert.equal(hostStatuses.includes('online'), true);
  } finally {
    await host.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('watcher 启动失败时 host 清理已启动的 SnowLuma 子进程', async () => {
  const fixture = createFixture();
  const child = new FakeChild();
  const host = createWindowsHost({
    accounts: [{ uin: 10001, snowlumaDir: fixture.snowlumaDir }],
    settings: { startSnowLuma: true, scanIntervalSec: 5 },
    password: 'unit-test-password-only',
    logDirectory: path.join(fixture.root, 'logs'),
    getAdapterStatus: () => 'connecting',
    spawnProcess: (() => child) as never,
    setInterval: (() => { throw new Error('fixture timer failure'); }) as never,
    fetch: (async () => new Response(JSON.stringify({
      success: true,
      token: 'unit-test-session',
      mustChangePassword: false,
    }))) as typeof fetch,
    log: () => {},
  });

  try {
    await assert.rejects(host.start(), /timer failure/);
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(host.status(), 'error');
  } finally {
    await host.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WebUI 在一次 401 重登录后仍拒绝请求时将 host 状态置为 error', async () => {
  const fixture = createFixture();
  let adapterStatus: 'connecting' | 'online' | 'offline' = 'connecting';
  let intervalCallback: (() => void) | undefined;
  let loginCount = 0;
  let processListCount = 0;
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
  const host = createWindowsHost({
    accounts: [{ uin: 10001, snowlumaDir: fixture.snowlumaDir }],
    settings: { startSnowLuma: false, scanIntervalSec: 5 },
    password: 'unit-test-password-only',
    logDirectory: path.join(fixture.root, 'logs'),
    getAdapterStatus: () => adapterStatus,
    setInterval: ((callback: () => void) => {
      intervalCallback = callback;
      return 1;
    }) as never,
    clearInterval: (() => {}) as never,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === '/api/login') {
        loginCount += 1;
        return new Response(JSON.stringify({ success: true, token: `unit-test-session-${loginCount}`, mustChangePassword: false }));
      }
      if (url.pathname === '/api/processes') {
        processListCount += 1;
        if (processListCount > 1) return new Response(JSON.stringify({ status: 'failed' }), { status: 401 });
        return new Response(JSON.stringify({ list: [processInfo] }));
      }
      if (url.pathname === '/api/processes/123/probe-login') {
        return new Response(JSON.stringify({ info: { port: 4301, uin: '10001', identityKnown: true } }));
      }
      if (url.pathname === '/api/processes/123/load') {
        return new Response(JSON.stringify({ success: true, process: { ...processInfo, injected: true, status: 'loaded' } }));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch,
    log: () => {},
  });

  try {
    await host.start();
    assert.equal(host.status(), 'waiting_qq_login');
    adapterStatus = 'online';
    intervalCallback?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(loginCount, 2);
    assert.equal(processListCount, 3);
    assert.equal(host.status(), 'error');
  } finally {
    await host.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('SnowLuma 在首次 WebUI 就绪前意外退出时保留退避重启并继续托管', async () => {
  const fixture = createFixture();
  const children: FakeChild[] = [];
  const restartDelays: number[] = [];
  let restartCallback: (() => void) | undefined;
  let clearTimerCalls = 0;
  let loginCount = 0;
  let processListCalls = 0;
  let intervalCallback: (() => void) | undefined;
  const host = createWindowsHost({
    accounts: [{ uin: 10001, snowlumaDir: fixture.snowlumaDir }],
    settings: { startSnowLuma: true, scanIntervalSec: 5 },
    password: 'unit-test-password-only',
    logDirectory: path.join(fixture.root, 'logs'),
    getAdapterStatus: () => 'connecting',
    spawnProcess: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never,
    setTimer: ((callback: () => void, delay: number) => {
      restartDelays.push(delay);
      restartCallback = callback;
      return 1;
    }) as never,
    clearTimer: (() => { clearTimerCalls += 1; }) as never,
    setInterval: ((callback: () => void) => {
      intervalCallback = callback;
      return 1;
    }) as never,
    clearInterval: (() => {}) as never,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === '/api/login') {
        loginCount += 1;
        if (loginCount === 1) return new Promise<Response>(() => {});
        return new Response(JSON.stringify({ success: true, token: 'unit-test-session-retry', mustChangePassword: false }));
      }
      if (url.pathname === '/api/processes') {
        processListCalls += 1;
        return new Response(JSON.stringify({ list: [] }));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch,
    log: () => {},
  });

  try {
    const initialStart = host.start();
    const firstChild = children[0];
    assert.ok(firstChild);
    (firstChild as FakeChild & { exitCode: number }).exitCode = 1;
    firstChild.emit('exit', 1, null);
    await initialStart;

    assert.equal(host.status(), 'starting');
    assert.deepEqual(restartDelays, [1_000]);
    assert.equal(clearTimerCalls, 0);

    restartCallback?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(children.length, 2);
    assert.equal(loginCount, 2);
    assert.equal(processListCalls, 1);
    assert.equal(host.status(), 'waiting_qq_login');
    assert.equal(typeof intervalCallback, 'function');
  } finally {
    await host.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('SnowLuma 在 watcher 首次扫描期间重启后仍恢复轮询', async () => {
  const fixture = createFixture();
  const children: FakeChild[] = [];
  let restartCallback: (() => void) | undefined;
  let releaseFirstList: (() => void) | undefined;
  let firstListStarted: (() => void) | undefined;
  let secondListStarted: (() => void) | undefined;
  let secondLoginStarted: (() => void) | undefined;
  let loginCount = 0;
  let processListCalls = 0;
  let intervalCalls = 0;
  let intervalCallback: (() => void) | undefined;
  const firstListStartedPromise = new Promise<void>((resolve) => { firstListStarted = resolve; });
  const secondListStartedPromise = new Promise<void>((resolve) => { secondListStarted = resolve; });
  const secondLoginStartedPromise = new Promise<void>((resolve) => { secondLoginStarted = resolve; });
  const host = createWindowsHost({
    accounts: [{ uin: 10001, snowlumaDir: fixture.snowlumaDir }],
    settings: { startSnowLuma: true, scanIntervalSec: 5 },
    password: 'unit-test-password-only',
    logDirectory: path.join(fixture.root, 'logs'),
    getAdapterStatus: () => 'connecting',
    spawnProcess: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never,
    setTimer: ((callback: () => void) => {
      restartCallback = callback;
      return 1;
    }) as never,
    clearTimer: (() => {}) as never,
    setInterval: ((callback: () => void) => {
      intervalCalls += 1;
      intervalCallback = callback;
      return 1;
    }) as never,
    clearInterval: (() => {}) as never,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === '/api/login') {
        loginCount += 1;
        if (loginCount === 2) secondLoginStarted?.();
        return new Response(JSON.stringify({ success: true, token: `unit-test-session-${loginCount}`, mustChangePassword: false }));
      }
      if (url.pathname === '/api/processes') {
        processListCalls += 1;
        if (processListCalls === 1) {
          firstListStarted?.();
          return new Promise<Response>((resolve) => {
            releaseFirstList = () => resolve(new Response(JSON.stringify({ list: [] })));
          });
        }
        if (processListCalls === 2) secondListStarted?.();
        return new Response(JSON.stringify({ list: [] }));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch,
    log: () => {},
  });

  try {
    const initialStart = host.start();
    await firstListStartedPromise;
    const firstChild = children[0];
    assert.ok(firstChild);
    (firstChild as FakeChild & { exitCode: number }).exitCode = 1;
    firstChild.emit('exit', 1, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    restartCallback?.();
    await secondLoginStartedPromise;
    releaseFirstList?.();
    await initialStart;

    const followup = await Promise.race([
      secondListStartedPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(followup, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(processListCalls, 2);
    assert.equal(intervalCalls, 1);

    intervalCallback?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(processListCalls, 3);
  } finally {
    await host.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('host 在 WebUI 启动期间收到 stop 时不启动 watcher 或报告启动错误', async () => {
  const fixture = createFixture();
  const child = new FakeChild();
  let releaseLogin: ((response: Response) => void) | undefined;
  let loginCalls = 0;
  let processListCalls = 0;
  let intervalCalls = 0;
  const statuses: string[] = [];
  const loginGate = new Promise<Response>((resolve) => { releaseLogin = resolve; });
  const host = createWindowsHost({
    accounts: [{ uin: 10001, snowlumaDir: fixture.snowlumaDir }],
    settings: { startSnowLuma: true, scanIntervalSec: 5 },
    password: 'unit-test-password-only',
    logDirectory: path.join(fixture.root, 'logs'),
    getAdapterStatus: () => 'connecting',
    spawnProcess: (() => child) as never,
    setInterval: (() => { intervalCalls += 1; return 1; }) as never,
    clearInterval: (() => {}) as never,
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === '/api/login') {
        loginCalls += 1;
        return loginGate;
      }
      if (url.pathname === '/api/processes') {
        processListCalls += 1;
        return new Response(JSON.stringify({ list: [] }));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch,
    log: () => {},
  });
  host.onStatus((status) => statuses.push(status));

  try {
    const starting = host.start();
    assert.equal(loginCalls, 1);
    const stopping = host.stop();
    releaseLogin?.(new Response(JSON.stringify({ success: true, token: 'unit-test-session', mustChangePassword: false })));
    await stopping;
    await starting;
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(processListCalls, 0);
    assert.equal(intervalCalls, 0);
    assert.equal(statuses.includes('error'), false);
  } finally {
    await host.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
