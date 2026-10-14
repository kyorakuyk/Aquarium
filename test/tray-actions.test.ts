import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createHostLifecycleQueue,
  createSnowLumaRestartHandler,
  createTrayMenuActionHandler,
} from '../src/host/windows/tray-actions.ts';

class FakeChild extends EventEmitter {
  unrefCalls = 0;

  unref(): this {
    this.unrefCalls += 1;
    return this;
  }
}

test('tray menu actions launch targets, toggle all accounts, restart host, and quit', async () => {
  const events: string[] = [];
  const spawns: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const child = new FakeChild();
  const handler = createTrayMenuActionHandler({
    panelPort: 5180,
    qqExePath: 'C:/fixture/QQ.exe',
    restartSnowLuma: async () => { events.push('host:restart'); },
    getManagement: () => [
      { muteAll() { events.push('management:mute:1'); }, unmuteAll() { events.push('management:unmute:1'); } },
      { muteAll() { events.push('management:mute:2'); }, unmuteAll() { events.push('management:unmute:2'); } },
    ],
    isShuttingDown: () => false,
    quit: () => {
      events.push('quit');
    },
    spawnProcess: ((command: string, args: string[], options: Record<string, unknown>) => {
      spawns.push({ command, args, options });
      return child;
    }) as never,
    logError: (message) => events.push(`error:${message}`),
  });

  await handler('open-console');
  await handler('open-qq');
  await handler('mute-all');
  await handler('unmute-all');
  await handler('restart-snowluma');
  await handler('quit');

  assert.deepEqual(spawns.map(({ command, args, options }) => ({ command, args, options })), [
    {
      command: 'cmd.exe',
      args: ['/c', 'start', '', 'http://127.0.0.1:5180'],
      options: { detached: true, stdio: 'ignore', windowsHide: true },
    },
    {
      command: 'C:/fixture/QQ.exe',
      args: [],
      options: { detached: true, stdio: 'ignore', windowsHide: false },
    },
  ]);
  assert.equal(child.unrefCalls, 2);
  assert.deepEqual(events, [
    'management:mute:1',
    'management:mute:2',
    'management:unmute:1',
    'management:unmute:2',
    'host:restart',
    'quit',
  ]);
});

test('tray menu actions do not start QQ without a configured path or restart during shutdown', async () => {
  let spawnCalls = 0;
  let stopCalls = 0;
  let startCalls = 0;
  let shuttingDown = false;
  const handler = createTrayMenuActionHandler({
    panelPort: 5180,
    qqExePath: ' ',
    restartSnowLuma: async () => { stopCalls += 1; startCalls += 1; },
    getManagement: () => [],
    isShuttingDown: () => shuttingDown,
    quit: () => { shuttingDown = true; },
    spawnProcess: (() => { spawnCalls += 1; return new FakeChild(); }) as never,
    logError: () => {},
  });

  await handler('open-qq');
  shuttingDown = true;
  await handler('restart-snowluma');

  assert.equal(spawnCalls, 0);
  assert.equal(stopCalls, 0);
  assert.equal(startCalls, 0);
});

test('host shutdown waits for an in-flight tray restart before stopping the host', async () => {
  const events: string[] = [];
  let releaseRestart: (() => void) | undefined;
  const restartGate = new Promise<void>((resolve) => {
    releaseRestart = resolve;
  });
  const lifecycle = createHostLifecycleQueue();
  const restart = lifecycle.run(async () => {
    events.push('restart:stop');
    await restartGate;
    events.push('restart:done');
  });
  const shutdown = (async () => {
    await lifecycle.idle();
    events.push('shutdown:stop');
  })();

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['restart:stop']);
  releaseRestart?.();
  await Promise.all([restart, shutdown]);

  assert.deepEqual(events, ['restart:stop', 'restart:done', 'shutdown:stop']);
});

test('SnowLuma restart stops then starts the managed host and skips start after shutdown', async () => {
  const events: string[] = [];
  let shuttingDown = false;
  let stopCount = 0;
  const host = {
    async stop() {
      events.push('stop');
      stopCount += 1;
      if (stopCount === 2) shuttingDown = true;
    },
    async start() { events.push('start'); },
  };
  const restart = createSnowLumaRestartHandler({
    lifecycle: createHostLifecycleQueue(),
    getHost: () => host,
    isShuttingDown: () => shuttingDown,
  });

  await restart();
  shuttingDown = false;
  await restart();

  assert.deepEqual(events, ['stop', 'start', 'stop']);
});

test('detached process spawn errors are logged without escaping the menu action', async () => {

  const errors: string[] = [];
  const child = new FakeChild();
  child.on('error', () => {});
  const handler = createTrayMenuActionHandler({
    panelPort: 5180,
    qqExePath: '',
    restartSnowLuma: async () => {},
    getManagement: () => [],
    isShuttingDown: () => false,
    quit: () => {},
    spawnProcess: (() => child) as never,
    logError: (message) => errors.push(message),
  });

  await handler('open-console');
  child.emit('error', new Error('fixture spawn failure'));

  assert.deepEqual(errors, ['托盘操作失败（open-console；Error）。']);
});
