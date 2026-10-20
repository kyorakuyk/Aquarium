import { SnowLumaWebUIError, type SnowLumaProcessInfo } from './snowluma-webui.ts';

interface QqWatcherClient {
  listProcesses(): Promise<SnowLumaProcessInfo[]>;
  load(pid: number): Promise<{ success: boolean }>;
}

export interface QqWatcherOptions {
  targetUins: number[];
  scanIntervalSec: number;
  getScanIntervalSec?: () => number;
  getClient: () => QqWatcherClient | undefined;
  onScan?: () => void;
  onInjected?: (uin: number) => void;
  onFatalError?: (error: SnowLumaWebUIError) => void;
  log?: (message: string) => void;
  debug?: (message: string) => void;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

interface PidDisposition {
  kind: 'injected' | 'ignored';
  uin?: number;
}

function processUin(process: SnowLumaProcessInfo): string | undefined {
  const value = process.loggedIn === true ? process.uin : undefined;
  const rawUin = value ?? process.account?.uin;
  if (rawUin === undefined || rawUin === null) return undefined;
  const uin = String(rawUin);
  return uin.length > 0 && uin !== '0' ? uin : undefined;
}

export function createQqWatcher(options: QqWatcherOptions) {
  if (!Number.isSafeInteger(options.scanIntervalSec) || options.scanIntervalSec <= 0) {
    throw new TypeError('QQ watcher scan interval must be a positive integer');
  }
  const targetUins = new Set(options.targetUins.filter((uin) => Number.isSafeInteger(uin) && uin > 0));
  const dispositions = new Map<number, PidDisposition>();
  const unknownWarned = new Set<number>();
  const setTimer = options.setInterval ?? globalThis.setInterval;
  const clearTimer = options.clearInterval ?? globalThis.clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerDelayMs: number | undefined;
  let scanInFlight: Promise<void> | undefined;
  let startInFlight: Promise<void> | undefined;
  let startRequested = false;
  let stopRequested = false;

  async function scanInternal(): Promise<void> {
    if (stopRequested) return;
    const client = options.getClient();
    if (!client) return;

    let processes: SnowLumaProcessInfo[];
    try {
      processes = await client.listProcesses();
    } catch (error) {
      if (reportFatalAuthError(error)) return;
      options.log?.('QQ 进程扫描失败；保留当前 PID 判定并在下一轮重试。');
      return;
    }
    if (stopRequested) return;

    const present = new Set(processes.map((process) => process.pid));
    for (const pid of dispositions.keys()) {
      if (!present.has(pid)) dispositions.delete(pid);
    }
    for (const pid of unknownWarned) {
      if (!present.has(pid)) unknownWarned.delete(pid);
    }

    for (const process of processes) {
      if (stopRequested) return;
      if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || dispositions.has(process.pid)) continue;
      if (process.status === 'online') {
        const onlineUin = processUin(process);
        const matchedOnlineUin = onlineUin === undefined
          ? undefined
          : [...targetUins].find((targetUin) => String(targetUin) === onlineUin);
        if (matchedOnlineUin !== undefined) {
          unknownWarned.delete(process.pid);
          dispositions.set(process.pid, { kind: 'injected', uin: matchedOnlineUin });
          options.debug?.(`PID ${process.pid} 状态为 online，已视为目标账号在线。`);
        }
        continue;
      }
      const uin = processUin(process);
      if (uin === undefined) {
        if (unknownWarned.has(process.pid)) {
          options.debug?.(`QQ 目标进程 PID ${process.pid} 身份仍未知；下一轮继续重试。`);
        } else {
          unknownWarned.add(process.pid);
          options.log?.(`QQ 目标进程 PID ${process.pid} 身份未知；下一轮将重试。`);
        }
        continue;
      }
      unknownWarned.delete(process.pid);
      const matchedUin = [...targetUins].find((targetUin) => String(targetUin) === uin);
      if (matchedUin === undefined) {
        options.debug?.(`PID ${process.pid} 探测结果：其他账号`);
        dispositions.set(process.pid, { kind: 'ignored' });
        continue;
      }
      options.debug?.(`PID ${process.pid} 探测结果：目标账号`);
      try {
        const result = await client.load(process.pid);
        if (stopRequested) return;
        if (result.success) {
          dispositions.set(process.pid, { kind: 'injected', uin: matchedUin });
          try {
            options.onInjected?.(matchedUin);
          } catch {
            options.log?.('QQ watcher 注入成功回调失败。');
          }
        } else {
          options.log?.(`QQ 目标进程 PID ${process.pid} 加载失败；下一轮将重试。`);
        }
      } catch (error) {
        if (reportFatalAuthError(error)) return;
        options.log?.(`QQ 目标进程 PID ${process.pid} 加载失败；下一轮将重试。`);
      }
    }
  }

  function reportFatalAuthError(error: unknown): boolean {
    if (!(error instanceof SnowLumaWebUIError) || error.code !== 'http' || error.status !== 401) return false;
    try {
      options.onFatalError?.(error);
    } catch {
      options.log?.('QQ watcher 致命认证错误回调失败。');
    }
    if (!options.onFatalError) options.log?.('SnowLuma WebUI 在一次重新登录后仍拒绝授权。');
    return true;
  }

  function scanOnce(): Promise<void> {
    if (scanInFlight) return scanInFlight;
    scanInFlight = scanInternal().finally(() => {
      scanInFlight = undefined;
      try {
        options.onScan?.();
      } catch {
        options.log?.('QQ watcher 状态回调失败。');
      }
      syncTimer();
    });
    return scanInFlight;
  }

  function syncTimer(): void {
    if (!startRequested || stopRequested) return;
    const intervalSec = options.getScanIntervalSec?.() ?? options.scanIntervalSec;
    if (!Number.isSafeInteger(intervalSec) || intervalSec <= 0) {
      options.log?.('QQ watcher 动态扫描间隔无效；使用配置间隔。');
    }
    const delayMs = (Number.isSafeInteger(intervalSec) && intervalSec > 0
      ? intervalSec
      : options.scanIntervalSec) * 1_000;
    if (timer !== undefined && timerDelayMs === delayMs) return;
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => { void scanOnce(); }, delayMs);
    timerDelayMs = delayMs;
  }

  function start(): Promise<void> {
    if (timer !== undefined) return Promise.resolve();
    if (startInFlight) return startInFlight;
    startRequested = true;
    stopRequested = false;
    startInFlight = (async () => {
      await scanOnce();
      syncTimer();
    })().finally(() => { startInFlight = undefined; });
    return startInFlight;
  }

  function stop(): void {
    startRequested = false;
    stopRequested = true;
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
      timerDelayMs = undefined;
    }
  }

  function reset(): void {
    dispositions.clear();
    unknownWarned.clear();
  }

  function injectedUins(): Set<number> {
    return new Set([...dispositions.values()]
      .flatMap((disposition) => disposition.kind === 'injected' && disposition.uin !== undefined ? [disposition.uin] : []));
  }

  return { start, stop, reset, scanOnce, injectedUins };
}
