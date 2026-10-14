import type { spawn as nodeSpawn } from 'node:child_process';
import type { AdapterStatus } from '../../adapters/types.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import { createQqWatcher } from './qq-watcher.ts';
import { createSnowLumaProcess, SnowLumaProcessError, type SnowLumaProcessStatus } from './snowluma-process.ts';
import type { Host, HostStatus } from '../types.ts';

export interface WindowsHostOptions {
  accounts: Array<Pick<AquariumConfig['accounts'][number], 'uin' | 'snowlumaDir'>>;
  settings: Pick<AquariumConfig['host'], 'startSnowLuma' | 'scanIntervalSec'>;
  password: string;
  logDirectory: string;
  getAdapterStatus: (uin: number) => AdapterStatus | undefined;
  fetch?: typeof globalThis.fetch;
  spawnProcess?: typeof nodeSpawn;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  readinessTimeoutMs?: number;
  retryIntervalMs?: number;
  requestTimeoutMs?: number;
  setTimer?: typeof globalThis.setTimeout;
  clearTimer?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function createWindowsHost(options: WindowsHostOptions): Host {
  if (options.accounts.length === 0) throw new Error('Windows host requires at least one account');
  const snowlumaDirs = new Set(options.accounts.map((account) => account.snowlumaDir));
  if (snowlumaDirs.size !== 1) throw new Error('Windows host accounts must share one SnowLuma directory');
  const snowlumaDir = options.accounts[0]?.snowlumaDir;
  if (!snowlumaDir) throw new Error('Windows host SnowLuma directory is missing');

  let currentStatus: HostStatus = 'starting';
  let currentMessage = '正在启动 Windows 托管。';
  let isStarted = false;
  let stopping = false;
  let initialStartPending = false;
  let processReady = false;
  let watcherStartInFlight: Promise<void> | undefined;
  let stopWatcher = (): void => {};
  const listeners = new Set<(status: HostStatus, message?: string) => void>();

  function setStatus(status: HostStatus, message: string): void {
    if (currentStatus === status && currentMessage === message) return;
    currentStatus = status;
    currentMessage = message;
    for (const listener of listeners) {
      try {
        listener(status, message);
      } catch {
        options.log?.('error', 'Windows host 状态回调失败。');
      }
    }
  }

  const processManager = createSnowLumaProcess({
    snowlumaDir,
    logDirectory: options.logDirectory,
    password: options.password,
    startSnowLuma: options.settings.startSnowLuma,
    fetch: options.fetch,
    spawnProcess: options.spawnProcess,
    now: options.now,
    sleep: options.sleep,
    readinessTimeoutMs: options.readinessTimeoutMs,
    retryIntervalMs: options.retryIntervalMs,
    requestTimeoutMs: options.requestTimeoutMs,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    log: (message) => options.log?.('info', message),
  });

  const watcher = createQqWatcher({
    targetUins: options.accounts.map((account) => account.uin),
    scanIntervalSec: options.settings.scanIntervalSec,
    getClient: processManager.webuiClient,
    onScan: recomputeStatus,
    onFatalError: (error) => {
      stopWatcher();
      setStatus('error', `SnowLuma WebUI 重登录后仍返回 HTTP ${error.status ?? 401}，托管已停止扫描。`);
    },
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
    log: (message) => options.log?.('warn', message),
  });
  stopWatcher = watcher.stop;

  function recomputeStatus(): void {
    if (!isStarted || stopping || !processReady || currentStatus === 'error') return;
    const online = [...watcher.injectedUins()].some((uin) => options.getAdapterStatus(uin) === 'online');
    setStatus(
      online ? 'online' : 'waiting_qq_login',
      online ? '小号已登录并连接。' : '等待小号 QQ 登录。',
    );
  }

  function ensureWatcherStarted(): Promise<void> {
    if (!isStarted || stopping || !processReady) return Promise.resolve();
    if (watcherStartInFlight) {
      return watcherStartInFlight.then(() => {
        if (isStarted && !stopping && processReady && currentStatus !== 'error') return ensureWatcherStarted();
      });
    }
    const startAttempt = watcher.start();
    const trackedStart = startAttempt.finally(() => {
      if (watcherStartInFlight === trackedStart) watcherStartInFlight = undefined;
    });
    watcherStartInFlight = trackedStart;
    return trackedStart;
  }

  function onProcessStatus(status: SnowLumaProcessStatus, message?: string): void {
    if (status === 'starting') {
      if (processReady) {
        watcher.stop();
        watcher.reset();
      }
      processReady = false;
      if (!stopping) setStatus('starting', message ?? 'SnowLuma 正在启动。');
    } else if (status === 'ready') {
      processReady = true;
      if (stopping) return;
      setStatus('waiting_qq_login', '等待小号 QQ 登录。');
      if (isStarted && !initialStartPending) {
        void ensureWatcherStarted().then(recomputeStatus).catch((error: unknown) => {
          setStatus('error', `QQ watcher 启动失败：${errorName(error)}`);
        });
      }
    } else if (status === 'error') {
      processReady = false;
      watcher.stop();
      setStatus('error', message ?? 'SnowLuma 托管启动失败。');
    }
  }

  processManager.onStatus(onProcessStatus);

  async function start(): Promise<void> {
    if (isStarted) return;
    isStarted = true;
    stopping = false;
    initialStartPending = true;
    setStatus('starting', '正在启动 Windows 托管。');
    try {
      await processManager.start();
      if (stopping || !isStarted) {
        processReady = false;
        initialStartPending = false;
        watcher.stop();
        return;
      }
      processReady = true;
      initialStartPending = false;
      await ensureWatcherStarted();
      if (stopping || !isStarted) {
        processReady = false;
        watcher.stop();
        return;
      }
      recomputeStatus();
    } catch (error) {
      initialStartPending = false;
      if (stopping || !isStarted) {
        processReady = false;
        watcher.stop();
        try {
          await processManager.stop();
        } catch (cleanupError) {
          options.log?.('error', `Windows host 取消启动后的清理异常：${errorName(cleanupError)}`);
        }
        return;
      }
      if (error instanceof SnowLumaProcessError
        && error.code === 'process-exited'
        && processManager.status() === 'starting'
        && !stopping) {
        return;
      }
      isStarted = false;
      processReady = false;
      watcher.stop();
      try {
        await processManager.stop();
      } catch (cleanupError) {
        options.log?.('error', `Windows host 启动失败后的清理异常：${errorName(cleanupError)}`);
      }
      setStatus('error', errorMessage(error));
      throw error;
    }
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    isStarted = false;
    watcher.stop();
    await processManager.stop();
    processReady = false;
  }

  return {
    start,
    stop,
    status: () => currentStatus,
    onStatus(callback) {
      listeners.add(callback);
      try {
        callback(currentStatus, currentMessage);
      } catch {
        options.log?.('error', 'Windows host 状态回调失败。');
      }
      return () => listeners.delete(callback);
    },
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return `Windows 托管启动失败（${error.code}）。`;
  }
  return `Windows 托管启动失败（${errorName(error)}）。`;
}
