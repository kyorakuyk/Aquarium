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
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

interface PidDisposition {
  kind: 'injected' | 'ignored';
  uin?: number;
}

interface UnknownIdentityState {
  startedAtMs: number;
  lastObservedAtMs: number;
  rounds: number;
  nextDebugAtMs: number;
}

const UNKNOWN_IDENTITY_FIRST_DEBUG_MS = 60_000;
const UNKNOWN_IDENTITY_FIVE_MINUTES_MS = 5 * 60_000;
const UNKNOWN_IDENTITY_THIRTY_MINUTES_MS = 30 * 60_000;
const UNKNOWN_IDENTITY_HOUR_MS = 60 * 60_000;

function nextUnknownIdentityDebugAtMs(elapsedMs: number): number {
  if (elapsedMs < UNKNOWN_IDENTITY_FIRST_DEBUG_MS) return UNKNOWN_IDENTITY_FIRST_DEBUG_MS;
  if (elapsedMs < UNKNOWN_IDENTITY_FIVE_MINUTES_MS) return UNKNOWN_IDENTITY_FIVE_MINUTES_MS;
  if (elapsedMs < UNKNOWN_IDENTITY_THIRTY_MINUTES_MS) return UNKNOWN_IDENTITY_THIRTY_MINUTES_MS;
  const hoursAfterThirtyMinutes = Math.floor((elapsedMs - UNKNOWN_IDENTITY_THIRTY_MINUTES_MS) / UNKNOWN_IDENTITY_HOUR_MS) + 1;
  return UNKNOWN_IDENTITY_THIRTY_MINUTES_MS + hoursAfterThirtyMinutes * UNKNOWN_IDENTITY_HOUR_MS;
}

function formatUnknownDuration(elapsedMs: number): string {
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  if (totalMinutes === 0) return `${Math.floor(elapsedMs / 1_000)} 秒`;
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`;
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
  const unknownIdentities = new Map<number, UnknownIdentityState>();
  const getNow = options.now ?? (() => globalThis.performance.now());
  const setTimer = options.setInterval ?? globalThis.setInterval;
  const clearTimer = options.clearInterval ?? globalThis.clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  let timerDelayMs: number | undefined;
  let scanInFlight: Promise<void> | undefined;
  let startInFlight: Promise<void> | undefined;
  let startRequested = false;
  let stopRequested = false;

  function recordUnknownIdentity(pid: number): void {
    const observedAtMs = getNow();
    const state = unknownIdentities.get(pid);
    if (!state) {
      const firstState: UnknownIdentityState = {
        startedAtMs: observedAtMs,
        lastObservedAtMs: observedAtMs,
        rounds: 1,
        nextDebugAtMs: UNKNOWN_IDENTITY_FIRST_DEBUG_MS,
      };
      unknownIdentities.set(pid, firstState);
      options.log?.(`QQ 目标进程 PID ${pid} 身份未知（已 0 秒 / 1 轮）；下一轮将重试。`);
      return;
    }

    state.lastObservedAtMs = Math.max(state.lastObservedAtMs, observedAtMs);
    state.rounds += 1;
    const elapsedMs = Math.max(0, state.lastObservedAtMs - state.startedAtMs);
    if (elapsedMs < state.nextDebugAtMs) return;

    state.nextDebugAtMs = nextUnknownIdentityDebugAtMs(elapsedMs);
    options.debug?.(`QQ 目标进程 PID ${pid} 身份仍未知（已 ${formatUnknownDuration(elapsedMs)} / ${state.rounds} 轮）；下一轮继续重试。`);
  }

  function notifyInjected(uin: number): void {
    try {
      options.onInjected?.(uin);
    } catch {
      options.log?.('QQ watcher 注入成功回调失败。');
    }
  }

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
    for (const pid of unknownIdentities.keys()) {
      if (!present.has(pid)) unknownIdentities.delete(pid);
    }

    for (const process of processes) {
      if (stopRequested) return;
      if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || dispositions.has(process.pid)) continue;
      if (process.status === 'online') {
        const onlineUin = processUin(process);
        if (onlineUin !== undefined) unknownIdentities.delete(process.pid);
        const matchedOnlineUin = onlineUin === undefined
          ? undefined
          : [...targetUins].find((targetUin) => String(targetUin) === onlineUin);
        if (matchedOnlineUin !== undefined) {
          dispositions.set(process.pid, { kind: 'injected', uin: matchedOnlineUin });
          options.debug?.(`PID ${process.pid} 状态为 online，已视为目标账号在线。`);
          notifyInjected(matchedOnlineUin);
        }
        continue;
      }
      const uin = processUin(process);
      if (uin === undefined) {
        recordUnknownIdentity(process.pid);
        continue;
      }
      unknownIdentities.delete(process.pid);
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
          notifyInjected(matchedUin);
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
    unknownIdentities.clear();
  }

  function injectedUins(): Set<number> {
    return new Set([...dispositions.values()]
      .flatMap((disposition) => disposition.kind === 'injected' && disposition.uin !== undefined ? [disposition.uin] : []));
  }

  return { start, stop, reset, scanOnce, injectedUins };
}
