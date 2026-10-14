import path from 'node:path';
import { Worker as NodeWorker, type WorkerOptions } from 'node:worker_threads';
import type { Icon, MenuItem, TrayOptions } from '@trayjs/trayjs';
import type { Host, HostStatus } from './types.ts';

export type TrayMenuAction =
  | 'open-console'
  | 'open-qq'
  | 'mute-all'
  | 'unmute-all'
  | 'restart-snowluma'
  | 'quit';

export type TrayMenuHandler = (action: TrayMenuAction) => void | Promise<void>;

export interface Tray {
  setState(state: HostStatus, tooltip: string): void;
  onMenu(handler: TrayMenuHandler): void;
  notify(text: string): void;
  dispose(): void;
}

interface TrayJsHandle {
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
  setIcon(icon: Icon): void;
  setTooltip(text: string): void;
  quit(): void;
}

type TrayJsConstructor = new (options: TrayOptions) => TrayJsHandle;

export interface TrayJsAdapterOptions {
  assetsDirectory: string;
  qqExePath: string;
  isAllMuted: () => boolean | Promise<boolean>;
  logError: (message: string) => void;
}

export interface TrayWorkerHandle {
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: unknown): void;
}

export type TrayWorkerFactory = (url: URL, options: WorkerOptions) => TrayWorkerHandle;

export type TrayWorkerHostMessage =
  | { type: 'set-state'; state: HostStatus; tooltip: string }
  | { type: 'notify'; text: string }
  | { type: 'all-muted-response'; requestId: number; allMuted: boolean }
  | { type: 'dispose' };

export type TrayWorkerMessage =
  | { type: 'get-all-muted'; requestId: number }
  | { type: 'clicked'; action: TrayMenuAction }
  | { type: 'adapter-error'; message: string };

const actionsByMenuId: Record<string, TrayMenuAction> = {
  'open-console': 'open-console',
  'open-qq': 'open-qq',
  'mute-all': 'mute-all',
  'unmute-all': 'unmute-all',
  'restart-snowluma': 'restart-snowluma',
  quit: 'quit',
};

function trayMenuAction(id: string, qqExePath: string): TrayMenuAction | undefined {
  if (id === 'open-qq' && qqExePath.trim() === '') return undefined;
  return actionsByMenuId[id];
}

export function createTrayJsAdapter(TrayConstructor: TrayJsConstructor, options: TrayJsAdapterOptions): Tray {
  let status: HostStatus = 'starting';
  let tooltip = '水族箱 · 启动中';
  let displayedTooltip = tooltip;
  let menuHandler: TrayMenuHandler | undefined;
  let disposed = false;
  let helperExited = false;
  let errorReported = false;
  const iconFor = (state: HostStatus): Icon => {
    const color = state === 'online' ? 'teal' : state === 'error' ? 'red' : 'yellow';
    return { png: '', ico: path.join(options.assetsDirectory, `${color}.ico`) };
  };
  const markHelperUnavailable = (message: string): void => {
    helperExited = true;
    if (disposed || errorReported) return;
    errorReported = true;
    try {
      options.logError(message);
    } catch {
      // 托盘错误日志不能影响 bot 生命周期。
    }
  };
  const reportHelperExit = (code: number | null): void => {
    markHelperUnavailable(`托盘辅助进程意外退出（code=${code ?? 'null'}）；Aquarium 继续运行。`);
  };
  const safely = (operation: () => void): void => {
    if (disposed || helperExited) return;
    try {
      operation();
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      markHelperUnavailable(`托盘辅助进程通信失败（${errorName}）；Aquarium 继续运行。`);
    }
  };
  const reportMenuActionFailure = (action: TrayMenuAction, error: unknown): void => {
    try {
      options.logError(`托盘菜单动作失败（${action}）：${error instanceof Error ? error.name : 'UnknownError'}`);
    } catch {
      // 用户菜单动作失败也不能中断 bot。
    }
  };
  const nativeTray = new TrayConstructor({
    tooltip: displayedTooltip,
    icon: iconFor(status),
    onMenuRequested: async (): Promise<MenuItem[]> => {
      let allMuted = false;
      try {
        allMuted = await options.isAllMuted();
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        try {
          options.logError(`托盘菜单状态读取失败（${errorName}）。`);
        } catch {
          // 菜单状态读取失败不能中断 bot。
        }
      }
      return [
        { id: 'status', title: tooltip, enabled: false },
        { id: 'separator-before-actions', separator: true },
        { id: 'open-console', title: '打开控制台' },
        { id: 'open-qq', title: '打开 QQ', enabled: options.qqExePath.trim() !== '' },
        { id: allMuted ? 'unmute-all' : 'mute-all', title: allMuted ? '恢复说话' : '全部闭嘴' },
        { id: 'restart-snowluma', title: '重启 SnowLuma' },
        { id: 'separator-before-quit', separator: true },
        { id: 'quit', title: '退出' },
      ];
    },
    onClicked: (id) => {
      if (disposed || helperExited) return;
      const action = trayMenuAction(id, options.qqExePath);
      if (!action) return;
      try {
        const result = menuHandler?.(action);
        if (result && typeof result.then === 'function') {
          void result.catch((error: unknown) => reportMenuActionFailure(action, error));
        }
      } catch (error) {
        reportMenuActionFailure(action, error);
      }
    },
  });
  nativeTray.on('ready', () => {
    safely(() => {
      nativeTray.setIcon(iconFor(status));
      nativeTray.setTooltip(displayedTooltip);
    });
  });
  nativeTray.on('close', (code) => {
    if (!disposed) reportHelperExit(code);
  });

  return {
    setState(nextStatus, nextTooltip) {
      status = nextStatus;
      tooltip = nextTooltip;
      displayedTooltip = nextTooltip;
      safely(() => {
        nativeTray.setIcon(iconFor(status));
        nativeTray.setTooltip(displayedTooltip);
      });
    },
    onMenu(handler) {
      menuHandler = handler;
    },
    notify(text) {
      displayedTooltip = `水族箱 · ${text}`;
      safely(() => nativeTray.setTooltip(displayedTooltip));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      menuHandler = undefined;
      if (helperExited) return;
      try {
        nativeTray.quit();
      } catch {
        // 退出时辅助进程可能已经关闭；不影响后续 host 清理。
      }
    },
  };
}

export function createTrayWorkerAdapter(worker: TrayWorkerHandle, options: TrayJsAdapterOptions): Tray {
  let status: HostStatus = 'starting';
  let tooltip = '水族箱 · 启动中';
  let menuHandler: TrayMenuHandler | undefined;
  let disposed = false;
  let workerFailed = false;
  let errorReported = false;

  const reportUnavailable = (message: string): void => {
    workerFailed = true;
    if (disposed || errorReported) return;
    errorReported = true;
    try {
      options.logError(message);
    } catch {
      // 托盘 worker 错误日志不能中断 bot 生命周期。
    }
  };
  const send = (message: TrayWorkerHostMessage): void => {
    if (disposed || workerFailed) return;
    try {
      worker.postMessage(message);
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      reportUnavailable(`托盘 worker 通信失败（${errorName}）；Aquarium 继续运行。`);
    }
  };
  const reportMenuActionFailure = (action: TrayMenuAction, error: unknown): void => {
    try {
      options.logError(`托盘菜单动作失败（${action}）：${error instanceof Error ? error.name : 'UnknownError'}`);
    } catch {
      // 用户菜单动作失败也不能中断 bot。
    }
  };
  worker.on('message', (rawMessage) => {
    if (disposed || workerFailed || !rawMessage || typeof rawMessage !== 'object') return;
    const message = rawMessage as Record<string, unknown>;
    if (message.type === 'get-all-muted' && Number.isSafeInteger(message.requestId)) {
      const requestId = message.requestId as number;
      void Promise.resolve()
        .then(() => options.isAllMuted())
        .then((allMuted) => send({ type: 'all-muted-response', requestId, allMuted }))
        .catch((error: unknown) => {
          const errorName = error instanceof Error ? error.name : 'UnknownError';
          try {
            options.logError(`托盘菜单状态读取失败（${errorName}）。`);
          } catch {
            // 菜单状态读取失败不能中断 bot。
          }
          send({ type: 'all-muted-response', requestId, allMuted: false });
        });
      return;
    }
    if (message.type === 'adapter-error' && typeof message.message === 'string') {
      reportUnavailable(message.message);
      return;
    }
    if (message.type !== 'clicked' || typeof message.action !== 'string') return;
    const action = message.action as TrayMenuAction;
    if (!Object.values(actionsByMenuId).includes(action)) return;
    if (action === 'open-qq' && options.qqExePath.trim() === '') return;
    try {
      const result = menuHandler?.(action);
      if (result && typeof result.then === 'function') {
        void result.catch((error: unknown) => reportMenuActionFailure(action, error));
      }
    } catch (error) {
      reportMenuActionFailure(action, error);
    }
  });
  worker.on('error', (error) => {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    reportUnavailable(`托盘 worker 出错（${errorName}）；Aquarium 继续运行。`);
  });
  worker.on('exit', (code) => {
    if (!disposed) reportUnavailable(`托盘 worker 意外退出（code=${code}）；Aquarium 继续运行。`);
  });

  return {
    setState(nextStatus, nextTooltip) {
      status = nextStatus;
      tooltip = nextTooltip;
      send({ type: 'set-state', state: status, tooltip });
    },
    onMenu(handler) {
      menuHandler = handler;
    },
    notify(text) {
      send({ type: 'notify', text });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      menuHandler = undefined;
      if (workerFailed) return;
      try {
        worker.postMessage({ type: 'dispose' } satisfies TrayWorkerHostMessage);
      } catch {
        // worker 已经退出时不影响后续 host 清理。
      }
    },
  };
}

export async function createWindowsTray(
  options: TrayJsAdapterOptions,
  createWorker: TrayWorkerFactory = (url, workerOptions) => new NodeWorker(url, workerOptions),
): Promise<Tray> {
  const worker = createWorker(new URL('./windows/tray-worker.ts', import.meta.url), {
    workerData: {
      assetsDirectory: options.assetsDirectory,
      qqExePath: options.qqExePath,
    },
  });
  return createTrayWorkerAdapter(worker, options);
}

export async function bindHostTrayAfterLoad(options: {
  host: Host;
  loadTray: () => Promise<Tray>;
  shouldContinue: () => boolean;
  onMenu: TrayMenuHandler;
}): Promise<(() => void) | undefined> {
  const tray = await options.loadTray();
  if (!options.shouldContinue()) {
    tray.dispose();
    return undefined;
  }
  return bindHostTray(options.host, tray, options.onMenu);
}

export function bindHostTray(
  host: Host,
  tray: Tray,
  onMenu: TrayMenuHandler,
): () => void {
  tray.onMenu(onMenu);
  let previousStatus: HostStatus | undefined;
  const unsubscribe = host.onStatus((status) => {
    tray.setState(status, tooltipFor(status));
    if (status === 'waiting_qq_login' && previousStatus !== status) {
      tray.notify('请登录小号 QQ');
    }
    previousStatus = status;
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    tray.dispose();
  };
}

function tooltipFor(status: HostStatus): string {
  switch (status) {
    case 'starting': return '水族箱 · 启动中';
    case 'waiting_qq_login': return '水族箱 · 等待小号登录';
    case 'online': return '水族箱 · 在线';
    case 'error': return '水族箱 · 出错';
  }
}
