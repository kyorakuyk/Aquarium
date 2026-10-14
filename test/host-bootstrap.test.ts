import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapHost } from '../src/host/bootstrap.ts';
import type { Host, HostStatus } from '../src/host/types.ts';

function fakeHost(events: string[], startError?: Error): Host {
  let currentStatus: HostStatus = 'starting';
  return {
    async start() {
      events.push('host:start');
      if (startError) throw startError;
    },
    async stop() { events.push('host:stop'); },
    status: () => currentStatus,
    onStatus(callback) {
      callback(currentStatus);
      return () => {};
    },
  };
}

test('host.enabled=false 时不创建或启动 host，保留旧启动路径', async () => {
  let factoryCalls = 0;
  const warnings: string[] = [];
  const host = await bootstrapHost({
    enabled: false,
    platform: 'win32',
    createWindowsHost: () => {
      factoryCalls += 1;
      return fakeHost([]);
    },
    onWarning: (message) => warnings.push(message),
    onStartError: () => {},
  });

  assert.equal(host, undefined);
  assert.equal(factoryCalls, 0);
  assert.deepEqual(warnings, []);
});

test('非 Windows 上启用 host 时只告警并返回，继续旧适配器路径', async () => {
  let factoryCalls = 0;
  const warnings: string[] = [];
  const host = await bootstrapHost({
    enabled: true,
    platform: 'linux',
    createWindowsHost: () => {
      factoryCalls += 1;
      return fakeHost([]);
    },
    onWarning: (message) => warnings.push(message),
    onStartError: () => {},
  });

  assert.equal(host, undefined);
  assert.equal(factoryCalls, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /Windows/);
});

test('Windows host 在返回前先启动；启动失败报告后仍返回可清理的 host', async () => {
  const events: string[] = [];
  const errors: unknown[] = [];
  const expectedHost = fakeHost(events, new Error('fixture start failure'));
  const host = await bootstrapHost({
    enabled: true,
    platform: 'win32',
    createWindowsHost: () => {
      events.push('host:create');
      return expectedHost;
    },
    onWarning: () => {},
    onStartError: (error) => errors.push(error),
  });

  assert.equal(host, expectedHost);
  assert.deepEqual(events, ['host:create', 'host:start']);
  assert.equal(errors.length, 1);
});

test('异步启动期间收到 shutdown 时，已登记的 host 会被停止且不报告启动失败', async () => {
  const events: string[] = [];
  const errors: unknown[] = [];
  let stopped = false;
  let releaseStart: (() => void) | undefined;
  let registeredHost: Host | undefined;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const expectedHost: Host = {
    start() {
      events.push('host:start');
      return startGate;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      events.push('host:stop');
    },
    status: () => 'starting',
    onStatus: () => () => {},
  };
  const startup = bootstrapHost({
    enabled: true,
    platform: 'win32',
    createWindowsHost: () => expectedHost,
    onHostCreated: (host) => { registeredHost = host; },
    shouldContinue: () => !stopped,
    onWarning: () => {},
    onStartError: (error) => errors.push(error),
  });

  assert.equal(registeredHost, expectedHost);
  assert.deepEqual(events, ['host:start']);
  assert.ok(registeredHost);
  await registeredHost.stop();
  releaseStart?.();

  assert.equal(await startup, undefined);
  assert.deepEqual(events, ['host:start', 'host:stop']);
  assert.deepEqual(errors, []);
});

test('startup task runner 不会在 shutdown 后启动剩余 adapter', async () => {
  const module = await import('../src/host/bootstrap.ts');
  const runStartupTasks = (module as unknown as {
    runStartupTasks?: unknown;
  }).runStartupTasks;
  assert.equal(typeof runStartupTasks, 'function');

  let active = true;
  const started: string[] = [];
  const runner = runStartupTasks as (
    items: readonly string[],
    shouldContinue: () => boolean,
    start: (item: string) => Promise<void>,
  ) => Promise<void>;
  await runner(['first', 'second'], () => active, async (item) => {
    started.push(item);
    active = false;
  });
  assert.deepEqual(started, ['first']);
});
