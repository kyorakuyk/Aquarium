import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRestartBackoff, createSnowLumaProcess } from '../src/host/windows/snowluma-process.ts';

function createFixture(hookAutoLoad: boolean): { root: string; snowlumaDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aquarium-host-process-'));
  const snowlumaDir = path.join(root, 'SnowLuma');
  mkdirSync(path.join(snowlumaDir, 'config'), { recursive: true });
  writeFileSync(path.join(snowlumaDir, 'index.mjs'), '', 'utf8');
  writeFileSync(path.join(snowlumaDir, 'config', 'runtime.json'), JSON.stringify({ hookAutoLoad }), 'utf8');
  return { root, snowlumaDir };
}

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

test('hookAutoLoad=true 时拒绝启动并且绝不创建 SnowLuma 子进程', async () => {
  const fixture = createFixture(true);
  let spawnCalls = 0;
  const hostProcess = createSnowLumaProcess({
    snowlumaDir: fixture.snowlumaDir,
    logDirectory: path.join(fixture.root, 'logs'),
    password: 'unit-test-password-only',
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error('spawn must not run');
    }) as never,
    fetch: (async () => {
      throw new Error('fetch must not run');
    }) as typeof fetch,
    log: () => {},
  });

  try {
    await assert.rejects(hostProcess.start(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'hook-autoload-enabled');
      return true;
    });
    assert.equal(spawnCalls, 0);
    assert.equal(hostProcess.status(), 'error');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('SnowLuma WebUI 监听通配地址时在启动子进程前 fail closed', async () => {
  const fixture = createFixture(false);
  writeFileSync(
    path.join(fixture.snowlumaDir, 'config', 'runtime.json'),
    JSON.stringify({ hookAutoLoad: false, webuiHost: '0.0.0.0' }),
    'utf8',
  );
  let spawnCalls = 0;
  let fetchCalls = 0;
  const hostProcess = createSnowLumaProcess({
    snowlumaDir: fixture.snowlumaDir,
    logDirectory: path.join(fixture.root, 'logs'),
    password: 'unit-test-password-only',
    spawnProcess: (() => {
      spawnCalls += 1;
      return new FakeChild();
    }) as never,
    fetch: (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ success: true, token: 'unit-test-session', mustChangePassword: false }));
    }) as typeof fetch,
    log: () => {},
  });

  try {
    await assert.rejects(hostProcess.start(), /loopback/i);
    assert.equal(spawnCalls, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(hostProcess.status(), 'error');
  } finally {
    await hostProcess.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('用隐藏 Node 子进程启动 SnowLuma，等待 WebUI 登录并记录 stdout/stderr', async () => {
  const fixture = createFixture(false);
  const child = new FakeChild();
  const spawnCalls: unknown[][] = [];
  const fakeFetch = (async () => new Response(JSON.stringify({
    success: true,
    token: 'unit-test-session-token',
    mustChangePassword: false,
  }), { status: 200 })) as typeof fetch;
  const hostProcess = createSnowLumaProcess({
    snowlumaDir: fixture.snowlumaDir,
    logDirectory: path.join(fixture.root, 'logs'),
    password: 'unit-test-password-only',
    parentEnvironment: {
      PATH: 'fixture-path',
      SNOWLUMA_HOOK_AUTOLOAD: 'true',
      snowluma_hook_autoload: 'true',
      SNOWLUMA_WEBUI_HOST: '0.0.0.0',
      SNOWLUMA_WEBUI_PORT: '1234',
      SNOWLUMA_WEBUI_TLS: 'true',
      SNOWLUMA_HOOK_AUTOLOAD_ALL: '1',
      SNOWLUMA_WEBUI_PASSWORD: 'fixture-only-not-a-secret',
    },
    spawnProcess: ((...args: unknown[]) => {
      spawnCalls.push(args);
      return child;
    }) as never,
    fetch: fakeFetch,
    log: () => {},
  });

  try {
    await hostProcess.start();
    assert.equal(hostProcess.status(), 'ready');
    assert.equal(spawnCalls.length, 1);
    const [command, args, spawnOptions] = spawnCalls[0] ?? [];
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [path.join(fixture.snowlumaDir, 'index.mjs')]);
    assert.equal((spawnOptions as { cwd?: string }).cwd, fixture.snowlumaDir);
    assert.equal((spawnOptions as { windowsHide?: boolean }).windowsHide, true);
    assert.deepEqual((spawnOptions as { stdio?: unknown }).stdio, ['ignore', 'pipe', 'pipe']);
    const childEnvironment = (spawnOptions as { env?: Record<string, string | undefined> }).env;
    assert.equal(childEnvironment?.PATH, 'fixture-path');
    assert.equal(childEnvironment?.SNOWLUMA_HOOK_AUTOLOAD, 'false');
    assert.equal(childEnvironment?.SNOWLUMA_WEBUI_HOST, '127.0.0.1');
    assert.equal(childEnvironment?.SNOWLUMA_WEBUI_PORT, '5099');
    assert.equal(childEnvironment?.SNOWLUMA_WEBUI_TLS, 'false');
    assert.equal(childEnvironment?.SNOWLUMA_HOOK_AUTOLOAD_ALL, undefined);
    assert.equal(childEnvironment?.SNOWLUMA_WEBUI_PASSWORD, undefined);
    assert.equal(childEnvironment?.snowluma_hook_autoload, undefined);

    child.stdout.write('snow stdout line\n');
    child.stderr.write('snow stderr line\n');
    const logFiles = readdirSync(path.join(fixture.root, 'logs'));
    assert.equal(logFiles.length, 1);
    const logText = readFileSync(path.join(fixture.root, 'logs', logFiles[0] ?? ''), 'utf8');
    assert.match(logText, /snow stdout line/);
    assert.match(logText, /snow stderr line/);

    await hostProcess.stop();
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(hostProcess.status(), 'stopped');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('SnowLuma 退避按 1s 指数增长、封顶 30s，稳定 5 分钟后重置', () => {
  const backoff = createRestartBackoff();

  assert.deepEqual(
    Array.from({ length: 7 }, () => backoff.nextDelay()),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
  assert.equal(backoff.nextDelay(5 * 60 * 1_000), 1_000);
});

test('SnowLuma 意外退出后按退避调度并重新启动', async () => {
  const fixture = createFixture(false);
  const children: FakeChild[] = [];
  const scheduledDelays: number[] = [];
  let restartCallback: (() => void) | undefined;
  let currentTime = 10_000;
  let loginCount = 0;
  const hostProcess = createSnowLumaProcess({
    snowlumaDir: fixture.snowlumaDir,
    logDirectory: path.join(fixture.root, 'logs'),
    password: 'unit-test-password-only',
    now: () => currentTime,
    setTimer: ((callback: () => void, delay: number) => {
      scheduledDelays.push(delay);
      restartCallback = callback;
      return 1;
    }) as never,
    clearTimer: (() => {}) as never,
    spawnProcess: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as never,
    fetch: (async () => {
      loginCount += 1;
      return new Response(JSON.stringify({
        success: true,
        token: `unit-test-session-${loginCount}`,
        mustChangePassword: false,
      }), { status: 200 });
    }) as typeof fetch,
    log: () => {},
  });

  try {
    await hostProcess.start();
    children[0]?.emit('exit', 1, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(scheduledDelays, [1_000]);
    assert.equal(hostProcess.status(), 'starting');

    currentTime += 1_000;
    restartCallback?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(children.length, 2);
    assert.equal(hostProcess.status(), 'ready');
    assert.equal(loginCount, 2);
  } finally {
    await hostProcess.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('WebUI 未就绪时每秒重试 60 次后报错并停止托管子进程', async () => {
  const fixture = createFixture(false);
  const child = new FakeChild();
  let currentTime = 0;
  let loginCalls = 0;
  const sleeps: number[] = [];
  const hostProcess = createSnowLumaProcess({
    snowlumaDir: fixture.snowlumaDir,
    logDirectory: path.join(fixture.root, 'logs'),
    password: 'unit-test-password-only',
    now: () => currentTime,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      currentTime += milliseconds;
    },
    spawnProcess: (() => child) as never,
    fetch: (async () => {
      loginCalls += 1;
      throw new Error('fixture network unavailable');
    }) as typeof fetch,
    log: () => {},
  });

  try {
    await assert.rejects(hostProcess.start(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'readiness-timeout');
      return true;
    });
    assert.equal(loginCalls, 60);
    assert.deepEqual(sleeps, Array.from({ length: 60 }, () => 1_000));
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(hostProcess.status(), 'error');
  } finally {
    await hostProcess.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('startSnowLuma=false 只等待已有 WebUI，不启动或停止任何子进程', async () => {
  const fixture = createFixture(false);
  let spawnCalls = 0;
  let loginCalls = 0;
  const logs: string[] = [];
  const hostProcess = createSnowLumaProcess({
    snowlumaDir: fixture.snowlumaDir,
    logDirectory: path.join(fixture.root, 'logs'),
    password: 'unit-test-password-only',
    startSnowLuma: false,
    parentEnvironment: {},
    spawnProcess: (() => {
      spawnCalls += 1;
      return new FakeChild();
    }) as never,
    fetch: (async () => {
      loginCalls += 1;
      return new Response(JSON.stringify({
        success: true,
        token: 'unit-test-session-token',
        mustChangePassword: false,
      }), { status: 200 });
    }) as typeof fetch,
    log: (message) => logs.push(message),
  });

  try {
    await hostProcess.start();
    assert.equal(hostProcess.status(), 'ready');
    assert.equal(spawnCalls, 0);
    assert.equal(loginCalls, 1);
    assert.ok(logs.some((message) => /外部管理的 SnowLuma/.test(message)));
    await hostProcess.stop();
    assert.equal(spawnCalls, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('startSnowLuma=false 在当前环境包含不安全 override 时拒绝 attach', async () => {
  const fixture = createFixture(false);
  let fetchCalls = 0;
  const hostProcess = createSnowLumaProcess({
    snowlumaDir: fixture.snowlumaDir,
    logDirectory: path.join(fixture.root, 'logs'),
    password: 'unit-test-password-only',
    startSnowLuma: false,
    parentEnvironment: {
      SNOWLUMA_HOOK_AUTOLOAD: 'true',
      SNOWLUMA_WEBUI_HOST: '0.0.0.0',
    },
    fetch: (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ success: true, token: 'unit-test-session-token', mustChangePassword: false }));
    }) as typeof fetch,
    log: () => {},
  });

  try {
    await assert.rejects(hostProcess.start(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'unmanaged-environment-unsafe');
      return true;
    });
    assert.equal(fetchCalls, 0);
    assert.equal(hostProcess.status(), 'error');
  } finally {
    await hostProcess.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
