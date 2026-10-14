import type { TrayOptions } from '@trayjs/trayjs';
import {
  createTrayJsAdapter,
  type Tray,
  type TrayWorkerHostMessage,
} from '../tray.ts';
import type { HostStatus } from '../types.ts';

interface TrayJsHandle {
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
  setIcon(icon: { png: string; ico: string }): void;
  setTooltip(text: string): void;
  quit(): void;
}

interface TrayWorkerPort {
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'close', listener: () => void): this;
  postMessage(message: unknown): void;
  close(): void;
}

export interface TrayWorkerData {
  assetsDirectory: string;
  qqExePath: string;
}

type TrayConstructor = new (options: TrayOptions) => TrayJsHandle;

const hostStatuses = new Set<HostStatus>(['starting', 'waiting_qq_login', 'online', 'error']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function startTrayWorker(
  Tray: TrayConstructor,
  port: TrayWorkerPort,
  workerData: TrayWorkerData,
): void {
  let disposed = false;
  let nextRequestId = 0;
  let tray: Tray | undefined;
  const pendingMuteRequests = new Map<number, (allMuted: boolean) => void>();

  const settlePendingMuteRequests = (): void => {
    for (const resolve of pendingMuteRequests.values()) resolve(false);
    pendingMuteRequests.clear();
  };
  const reportWorkerError = (message: string): void => {
    if (disposed) return;
    disposed = true;
    settlePendingMuteRequests();
    try {
      port.postMessage({ type: 'adapter-error', message });
    } catch {
      // Parent thread is already gone; this worker is isolated from Aquarium.
    }
    tray?.dispose();
    port.close();
  };
  tray = createTrayJsAdapter(Tray, {
    assetsDirectory: workerData.assetsDirectory,
    qqExePath: workerData.qqExePath,
    isAllMuted: () => new Promise<boolean>((resolve) => {
      if (disposed) {
        resolve(false);
        return;
      }
      nextRequestId += 1;
      const requestId = nextRequestId;
      pendingMuteRequests.set(requestId, resolve);
      try {
        port.postMessage({ type: 'get-all-muted', requestId });
      } catch (error) {
        pendingMuteRequests.delete(requestId);
        resolve(false);
        reportWorkerError(`托盘 worker 请求菜单状态失败（${errorName(error)}）；Aquarium 继续运行。`);
      }
    }),
    logError: reportWorkerError,
  });
  tray.onMenu((action) => {
    if (disposed) return;
    try {
      port.postMessage({ type: 'clicked', action });
    } catch (error) {
      reportWorkerError(`托盘 worker 转发菜单动作失败（${errorName(error)}）；Aquarium 继续运行。`);
    }
  });

  port.on('message', (rawMessage) => {
    if (disposed || !isRecord(rawMessage) || typeof rawMessage.type !== 'string') return;
    switch (rawMessage.type) {
      case 'set-state': {
        const { state, tooltip } = rawMessage;
        if (typeof state === 'string' && hostStatuses.has(state as HostStatus) && typeof tooltip === 'string') {
          tray.setState(state as HostStatus, tooltip);
        }
        return;
      }
      case 'notify':
        if (typeof rawMessage.text === 'string') tray.notify(rawMessage.text);
        return;
      case 'all-muted-response': {
        const { requestId, allMuted } = rawMessage;
        if (!Number.isSafeInteger(requestId) || typeof allMuted !== 'boolean') return;
        const resolve = pendingMuteRequests.get(requestId as number);
        if (!resolve) return;
        pendingMuteRequests.delete(requestId as number);
        resolve(allMuted);
        return;
      }
      case 'dispose':
        disposed = true;
        settlePendingMuteRequests();
        tray.dispose();
        port.close();
    }
  });
  port.on('close', () => {
    if (disposed) return;
    disposed = true;
    settlePendingMuteRequests();
    tray?.dispose();
  });
}
