import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const INSTANCE_LOCK_HEARTBEAT_MS = 45_000;
export const INSTANCE_LOCK_STALE_MS = 2 * INSTANCE_LOCK_HEARTBEAT_MS;
const CLAIM_STALE_MS = 10_000;

type LogLevel = 'info' | 'warn' | 'error';

interface LockRecord {
  pid: number;
  startedAt: number;
  heartbeatAt?: number;
  token?: string;
}

interface ClaimRecord {
  pid: number;
  createdAt: number;
  token: string;
}

interface MutationClaim {
  path: string;
  record: ClaimRecord;
}

type ClaimResult =
  | { kind: 'acquired'; claim: MutationClaim }
  | { kind: 'busy'; reason: string }
  | { kind: 'failed'; error: unknown };

export interface InstanceLockHandle {
  allowed: boolean;
  degraded: boolean;
  reason: string;
  release: () => void;
}

export interface InstanceLockOptions {
  lockPath: string;
  pid?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  clearInterval?: typeof globalThis.clearInterval;
  onLog?: (level: LogLevel, message: string) => void;
  onLost?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (!isRecord(error) || typeof error.code !== 'string') return 'unknown';
  return error.code;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function parseLock(raw: string | undefined): LockRecord | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const pid = Number(value.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const startedAt = Number(value.startedAt);
  const heartbeatAt = Number(value.heartbeatAt);
  return {
    pid,
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0,
    ...(Number.isFinite(heartbeatAt) && heartbeatAt > 0 ? { heartbeatAt } : {}),
    ...(typeof value.token === 'string' && value.token !== '' ? { token: value.token } : {}),
  };
}

function parseClaim(raw: string | undefined): ClaimRecord | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const pid = Number(value.pid);
  const createdAt = Number(value.createdAt);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(createdAt) || createdAt <= 0) return undefined;
  if (typeof value.token !== 'string' || value.token === '') return undefined;
  return { pid, createdAt, token: value.token };
}

function readText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function writeTemporaryRecord(filePath: string, value: object, pid: number): string {
  const temporaryPath = `${filePath}.${pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return temporaryPath;
}

function removeTemporaryFile(filePath: string): void {
  try { unlinkSync(filePath); } catch { /* temporary cleanup is best-effort */ }
}

function createExclusiveRecord(filePath: string, value: object, pid: number): void {
  const temporaryPath = writeTemporaryRecord(filePath, value, pid);
  try {
    linkSync(temporaryPath, filePath);
  } finally {
    removeTemporaryFile(temporaryPath);
  }
}

function replaceRecord(filePath: string, value: object, pid: number): void {
  const temporaryPath = writeTemporaryRecord(filePath, value, pid);
  try {
    renameSync(temporaryPath, filePath);
  } finally {
    removeTemporaryFile(temporaryPath);
  }
}

function processIsAlive(pid: number, isAlive: (pid: number) => boolean): boolean {
  try { return isAlive(pid); } catch { return true; }
}

function isLockFresh(
  lock: LockRecord | undefined,
  now: number,
  staleMs: number,
  isAlive: (pid: number) => boolean,
): lock is LockRecord {
  if (!lock || !processIsAlive(lock.pid, isAlive)) return false;
  if (lock.heartbeatAt === undefined) return true;
  return now - lock.heartbeatAt < staleMs;
}

function acquireMutationClaim(options: {
  lockPath: string;
  pid: number;
  now: () => number;
  isAlive: (pid: number) => boolean;
}): ClaimResult {
  const claimPath = `${options.lockPath}.claim`;
  const createClaim = (): MutationClaim => {
    const record = { pid: options.pid, createdAt: options.now(), token: randomUUID() };
    createExclusiveRecord(claimPath, record, options.pid);
    return { path: claimPath, record };
  };

  try {
    return { kind: 'acquired', claim: createClaim() };
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') return { kind: 'failed', error };
  }

  let existing: ClaimRecord | undefined;
  try { existing = parseClaim(readText(claimPath)); } catch (error) {
    return { kind: 'busy', reason: `无法确认启动锁更新状态（${errorCode(error)}）` };
  }
  const currentTime = options.now();
  const stale = !existing
    || !processIsAlive(existing.pid, options.isAlive)
    || currentTime - existing.createdAt >= CLAIM_STALE_MS;
  if (!stale) return { kind: 'busy', reason: `启动锁正在由 pid ${existing?.pid ?? 'unknown'} 更新` };

  try { unlinkSync(claimPath); } catch (error) {
    if (errorCode(error) !== 'ENOENT') return { kind: 'busy', reason: `无法回收启动锁更新令牌（${errorCode(error)}）` };
  }
  try {
    return { kind: 'acquired', claim: createClaim() };
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return { kind: 'busy', reason: '另一个实例正在更新启动锁' };
    return { kind: 'failed', error };
  }
}

function releaseMutationClaim(claim: MutationClaim): void {
  try {
    const current = parseClaim(readText(claim.path));
    if (current?.token === claim.record.token) unlinkSync(claim.path);
  } catch { /* a failed claim cleanup is recovered by its owner timestamp */ }
}

function makeHandle(allowed: boolean, degraded: boolean, reason: string, release: () => void): InstanceLockHandle {
  return { allowed, degraded, reason, release };
}

export function acquireInstanceLock(options: InstanceLockOptions): InstanceLockHandle {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const setTimer = options.setInterval ?? ((callback, delayMs) => globalThis.setInterval(callback, delayMs));
  const clearTimer = options.clearInterval ?? globalThis.clearInterval;
  const staleMs = INSTANCE_LOCK_STALE_MS;
  const log = (level: LogLevel, message: string): void => {
    try { options.onLog?.(level, message); } catch { /* logging must not affect lock ownership */ }
  };
  const refused = (reason: string): InstanceLockHandle => makeHandle(false, false, reason, () => {});
  const degraded = (reason: string): InstanceLockHandle => {
    log('warn', `启动锁文件不可用，降级放行：${reason}`);
    return makeHandle(true, true, reason, () => {});
  };

  try {
    mkdirSync(dirname(options.lockPath), { recursive: true });
  } catch (error) {
    return degraded(`无法准备锁文件目录（${errorCode(error)}）`);
  }

  let initialRaw: string | undefined;
  try { initialRaw = readText(options.lockPath); } catch (error) {
    const reason = `无法读取启动锁（${errorCode(error)}）`;
    log('error', reason);
    return refused(reason);
  }
  const initialLock = parseLock(initialRaw);
  if (isLockFresh(initialLock, now(), staleMs, isAlive)) {
    return refused(`已有 Aquarium 实例运行：pid ${initialLock.pid}，心跳仍新鲜`);
  }

  const claimResult = acquireMutationClaim({ lockPath: options.lockPath, pid, now, isAlive });
  if (claimResult.kind === 'busy') return refused(claimResult.reason);
  if (claimResult.kind === 'failed') return degraded(`无法取得锁更新令牌（${errorCode(claimResult.error)}）`);
  const claim = claimResult.claim;
  const token = randomUUID();
  const createdAt = now();
  const ownRecord: LockRecord = { pid, startedAt: createdAt, heartbeatAt: createdAt, token };
  let ownedRecord: LockRecord | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let released = false;
  let lost = false;

  const release = (): void => {
    if (released) return;
    released = true;
    if (heartbeatTimer !== undefined) clearTimer(heartbeatTimer);
    const releaseClaimResult = acquireMutationClaim({ lockPath: options.lockPath, pid, now, isAlive });
    if (releaseClaimResult.kind !== 'acquired') {
      if (releaseClaimResult.kind === 'failed') log('warn', `释放启动锁时无法取得更新令牌（${errorCode(releaseClaimResult.error)}）`);
      return;
    }
    try {
      const current = parseLock(readText(options.lockPath));
      if (current?.token === token) unlinkSync(options.lockPath);
    } catch (error) {
      log('warn', `释放启动锁失败（${errorCode(error)}）`);
    } finally {
      releaseMutationClaim(releaseClaimResult.claim);
    }
  };

  const handleLostOwnership = (): void => {
    if (lost || released) return;
    lost = true;
    if (heartbeatTimer !== undefined) clearTimer(heartbeatTimer);
    log('warn', '启动锁已被其他 Aquarium 实例接管；当前实例开始关闭。');
    try { options.onLost?.(); } catch { /* keep the lock manager alive */ }
  };

  const heartbeat = (): void => {
    if (released || lost || !ownedRecord) return;
    const heartbeatClaim = acquireMutationClaim({ lockPath: options.lockPath, pid, now, isAlive });
    if (heartbeatClaim.kind === 'busy') return;
    if (heartbeatClaim.kind === 'failed') {
      log('warn', `启动锁心跳无法取得更新令牌（${errorCode(heartbeatClaim.error)}）`);
      return;
    }
    try {
      const current = parseLock(readText(options.lockPath));
      if (current?.token !== token) {
        handleLostOwnership();
        return;
      }
      const updated = { ...ownedRecord, heartbeatAt: now() };
      replaceRecord(options.lockPath, updated, pid);
      ownedRecord = updated;
    } catch (error) {
      log('warn', `启动锁心跳写入失败（${errorCode(error)}）`);
    } finally {
      releaseMutationClaim(heartbeatClaim.claim);
    }
  };

  try {
    const currentRaw = readText(options.lockPath);
    const current = parseLock(currentRaw);
    if (isLockFresh(current, now(), staleMs, isAlive)) {
      releaseMutationClaim(claim);
      return refused(`已有 Aquarium 实例运行：pid ${current.pid}，心跳仍新鲜`);
    }
    if (currentRaw === undefined) createExclusiveRecord(options.lockPath, ownRecord, pid);
    else replaceRecord(options.lockPath, ownRecord, pid);
    ownedRecord = ownRecord;
  } catch (error) {
    releaseMutationClaim(claim);
    return degraded(`启动锁写入失败（${errorCode(error)}）`);
  }
  releaseMutationClaim(claim);

  try {
    heartbeatTimer = setTimer(heartbeat, INSTANCE_LOCK_HEARTBEAT_MS);
    (heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  } catch (error) {
    release();
    return degraded(`无法启动锁心跳计时器（${errorCode(error)}）`);
  }

  const reason = initialRaw === undefined ? '首次启动已持有实例锁' : '已接管过期实例锁';
  if (initialRaw !== undefined) log('warn', reason);
  return makeHandle(true, false, reason, release);
}
