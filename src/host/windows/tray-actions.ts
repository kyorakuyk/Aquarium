import { spawn, type SpawnOptions } from 'node:child_process';
import type { Host } from '../types.ts';
import type { TrayMenuAction } from '../tray.ts';

export interface TrayManagementController {
  muteAll(): void;
  unmuteAll(): void;
}

export interface TrayMenuActionOptions {
  panelPort: number;
  qqExePath: string;
  restartSnowLuma: () => Promise<void>;
  getManagement: () => TrayManagementController[];
  isShuttingDown: () => boolean;
  quit: () => void | Promise<void>;
  spawnProcess?: typeof spawn;
  logError: (message: string) => void;
}

export interface HostLifecycleQueue {
  run(operation: () => Promise<void>): Promise<void>;
  idle(): Promise<void>;
}

export function createHostLifecycleQueue(): HostLifecycleQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    run(operation) {
      const current = tail.then(operation, operation);
      tail = current.catch(() => {
        // 保持队列可继续执行；当前调用方仍会收到 `current` 的拒绝。
      });
      return current;
    },
    idle: () => tail,
  };
}

export function createSnowLumaRestartHandler(options: {
  lifecycle: HostLifecycleQueue;
  getHost: () => Pick<Host, 'start' | 'stop'> | undefined;
  isShuttingDown: () => boolean;
}): () => Promise<void> {
  return () => options.lifecycle.run(async () => {
    const host = options.getHost();
    if (!host || options.isShuttingDown()) return;
    await host.stop();
    if (!options.isShuttingDown() && options.getHost() === host) await host.start();
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function createTrayMenuActionHandler(
  options: TrayMenuActionOptions,
): (action: TrayMenuAction) => Promise<void> {
  const spawnProcess = options.spawnProcess ?? spawn;

  const reportFailure = (action: TrayMenuAction, error: unknown): void => {
    try {
      options.logError(`托盘操作失败（${action}；${errorName(error)}）。`);
    } catch {
      // 托盘操作的错误报告不能中断 Aquarium。
    }
  };
  const launch = (action: TrayMenuAction, command: string, args: string[], windowsHide: boolean): void => {
    const child = spawnProcess(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide,
    } satisfies SpawnOptions);
    child.once('error', (error) => reportFailure(action, error));
    child.unref();
  };

  return async (action): Promise<void> => {
    if (action !== 'quit' && options.isShuttingDown()) return;
    try {
      switch (action) {
        case 'open-console':
          launch('open-console', 'cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${options.panelPort}`], true);
          return;
        case 'open-qq':
          if (options.qqExePath.trim() !== '') launch('open-qq', options.qqExePath, [], false);
          return;
        case 'mute-all':
          for (const management of options.getManagement()) management.muteAll();
          return;
        case 'unmute-all':
          for (const management of options.getManagement()) management.unmuteAll();
          return;
        case 'restart-snowluma':
          await options.restartSnowLuma();
          return;
        case 'quit':
          await options.quit();
      }
    } catch (error) {
      reportFailure(action, error);
    }
  };
}
