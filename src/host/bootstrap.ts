import type { Host } from './types.ts';

export interface HostBootstrapOptions {
  enabled: boolean;
  platform: string;
  createWindowsHost: () => Host;
  onHostCreated?: (host: Host) => void;
  shouldContinue?: () => boolean;
  onWarning: (message: string) => void;
  onStartError: (error: unknown) => void;
  onStopError?: (error: unknown) => void;
}

export async function bootstrapHost(options: HostBootstrapOptions): Promise<Host | undefined> {
  if (!options.enabled) return undefined;
  if (options.platform !== 'win32') {
    options.onWarning('Windows 托管仅支持 Windows；本次按 host.enabled=false 继续启动。');
    return undefined;
  }
  const shouldContinue = options.shouldContinue ?? (() => true);
  if (!shouldContinue()) return undefined;

  let host: Host;
  try {
    host = options.createWindowsHost();
  } catch (error) {
    options.onStartError(error);
    return undefined;
  }
  options.onHostCreated?.(host);
  const stopCancelledHost = async (): Promise<void> => {
    try {
      await host.stop();
    } catch (error) {
      options.onStopError?.(error);
    }
  };
  if (!shouldContinue()) {
    await stopCancelledHost();
    return undefined;
  }
  try {
    await host.start();
  } catch (error) {
    if (!shouldContinue()) {
      await stopCancelledHost();
      return undefined;
    }
    options.onStartError(error);
  }
  if (!shouldContinue()) {
    await stopCancelledHost();
    return undefined;
  }
  return host;
}

export async function runStartupTasks<T>(
  items: readonly T[],
  shouldContinue: () => boolean,
  startTask: (item: T) => Promise<void>,
): Promise<void> {
  for (const item of items) {
    if (!shouldContinue()) return;
    await startTask(item);
  }
}
