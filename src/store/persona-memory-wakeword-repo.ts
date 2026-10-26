import type { DatabaseSync } from 'node:sqlite';

export interface PersonaMemoryWakeWordJobInput {
  account: number;
  sessionId: string;
  cycleKey: string;
  wakeMessageId: string;
  bedAt: number;
  wakeAt: number;
  messageIds: readonly string[];
  createdAt: number;
  nextAttemptAt: number;
  expiresAt: number;
}

export interface PersonaMemoryWakeWordJobRecord extends PersonaMemoryWakeWordJobInput {
  id: number;
  status: 'pending' | 'sending' | 'scheduled' | 'skipped' | 'expired';
  attemptCount: number;
  updatedAt: number;
  lastReason: string | null;
}

export interface PersonaMemoryWakeWordRepository {
  enqueuePersonaMemoryWakeWordJob(input: PersonaMemoryWakeWordJobInput): boolean;
  listPendingPersonaMemoryWakeWordJobs(account: number, now: number, limit: number): PersonaMemoryWakeWordJobRecord[];
  claimPersonaMemoryWakeWordJob(account: number, id: number, now: number): boolean;
  deferPersonaMemoryWakeWordJob(account: number, id: number, now: number, nextAttemptAt: number, reason: string): boolean;
  finishPersonaMemoryWakeWordJob(account: number, id: number, now: number): boolean;
  skipPersonaMemoryWakeWordJob(account: number, id: number, now: number, reason: string): boolean;
  expirePersonaMemoryWakeWordJobs(account: number, now: number): number;
  recoverPersonaMemoryWakeWordJobs(account: number, now: number): number;
}

const MAX_MESSAGE_IDS = 1_000;

function safeInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const result = Number(value);
    if (Number.isSafeInteger(result)) return result;
  }
  throw new Error(`数据库字段 ${field} 不是安全整数`);
}

function validMessageIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_MESSAGE_IDS
    && value.every((messageId) => typeof messageId === 'string' && messageId.length > 0 && messageId.length <= 512);
}

function parseMessageIds(value: unknown): string[] {
  if (typeof value !== 'string') throw new Error('唤醒词积压消息 ID 不是 JSON');
  const parsed: unknown = JSON.parse(value);
  if (!validMessageIds(parsed)) throw new Error('唤醒词积压消息 ID 无效');
  return [...new Set(parsed)];
}

function validScope(account: number, sessionId: string): boolean {
  return Number.isSafeInteger(account) && account > 0 && typeof sessionId === 'string'
    && sessionId.startsWith(`${account}:`) && sessionId.length > 0 && sessionId.length <= 512;
}

function validInput(input: PersonaMemoryWakeWordJobInput): boolean {
  return validScope(input.account, input.sessionId)
    && /^\d{4}-\d{2}-\d{2}$/u.test(input.cycleKey)
    && typeof input.wakeMessageId === 'string' && input.wakeMessageId.length > 0 && input.wakeMessageId.length <= 512
    && Number.isSafeInteger(input.bedAt) && input.bedAt >= 0
    && Number.isSafeInteger(input.wakeAt) && input.wakeAt > input.bedAt
    && validMessageIds(input.messageIds)
    && Number.isSafeInteger(input.createdAt) && input.createdAt >= 0
    && Number.isSafeInteger(input.nextAttemptAt) && input.nextAttemptAt >= input.createdAt
    && Number.isSafeInteger(input.expiresAt) && input.expiresAt > input.nextAttemptAt;
}

function record(row: Record<string, unknown>): PersonaMemoryWakeWordJobRecord {
  const id = safeInteger(row.id, 'id');
  const account = safeInteger(row.account, 'account');
  const sessionId = String(row.session_id);
  const cycleKey = String(row.cycle_key);
  const wakeMessageId = String(row.wake_message_id);
  const bedAt = safeInteger(row.bed_at, 'bed_at');
  const wakeAt = safeInteger(row.wake_at, 'wake_at');
  const messageIds = parseMessageIds(row.message_ids_json);
  const status = row.status;
  const attemptCount = safeInteger(row.attempt_count, 'attempt_count');
  const nextAttemptAt = safeInteger(row.next_attempt_at, 'next_attempt_at');
  const createdAt = safeInteger(row.created_at, 'created_at');
  const expiresAt = safeInteger(row.expires_at, 'expires_at');
  const updatedAt = safeInteger(row.updated_at, 'updated_at');
  const lastReason = row.last_reason;
  if (!Number.isSafeInteger(id) || id <= 0 || !validScope(account, sessionId)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(cycleKey)
    || wakeMessageId.length === 0 || wakeMessageId.length > 512
    || bedAt < 0 || wakeAt <= bedAt || attemptCount < 0
    || !['pending', 'sending', 'scheduled', 'skipped', 'expired'].includes(String(status))
    || nextAttemptAt < createdAt || expiresAt <= nextAttemptAt || updatedAt < 0
    || (lastReason !== null && (typeof lastReason !== 'string' || lastReason.length > 120))) {
    throw new Error('唤醒词积压任务记录无效');
  }
  return {
    id, account, sessionId, cycleKey, wakeMessageId, bedAt, wakeAt, messageIds,
    status: status as PersonaMemoryWakeWordJobRecord['status'],
    attemptCount, nextAttemptAt, createdAt, expiresAt, updatedAt,
    lastReason: lastReason as string | null,
  };
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000;
}

function validReason(value: string): boolean {
  return typeof value === 'string' && value.length <= 120;
}

export function createPersonaMemoryWakeWordRepository(database: DatabaseSync): PersonaMemoryWakeWordRepository {
  const insert = database.prepare(`
    INSERT INTO persona_memory_wake_word_jobs (
      account, session_id, cycle_key, wake_message_id, bed_at, wake_at, message_ids_json,
      status, attempt_count, next_attempt_at, created_at, expires_at, updated_at, last_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL)
    ON CONFLICT (account, session_id, cycle_key) DO UPDATE SET
      wake_message_id = excluded.wake_message_id,
      bed_at = excluded.bed_at,
      wake_at = excluded.wake_at,
      message_ids_json = excluded.message_ids_json,
      next_attempt_at = excluded.next_attempt_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at,
      last_reason = NULL
    WHERE persona_memory_wake_word_jobs.status = 'pending'
  `);
  const selectPending = database.prepare(`
    SELECT * FROM persona_memory_wake_word_jobs
    WHERE account = ? AND status = 'pending' AND next_attempt_at <= ? AND expires_at > ?
    ORDER BY next_attempt_at, id LIMIT ?
  `);

  return {
    enqueuePersonaMemoryWakeWordJob(input) {
      if (!validInput(input)) throw new RangeError('唤醒词积压任务无效');
      const messageIds = [...new Set(input.messageIds)];
      if (messageIds.length === 0 || messageIds.length > MAX_MESSAGE_IDS) return false;
      const result = insert.run(
        input.account,
        input.sessionId,
        input.cycleKey,
        input.wakeMessageId,
        input.bedAt,
        input.wakeAt,
        JSON.stringify(messageIds),
        input.nextAttemptAt,
        input.createdAt,
        input.expiresAt,
        input.createdAt,
      );
      return result.changes === 1 || result.changes === 1n;
    },

    listPendingPersonaMemoryWakeWordJobs(account, now, limit) {
      if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(now) || now < 0 || !validLimit(limit)) return [];
      return (selectPending.all(account, now, now, limit) as Array<Record<string, unknown>>).map(record);
    },

    claimPersonaMemoryWakeWordJob(account, id, now) {
      if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(id) || id <= 0
        || !Number.isSafeInteger(now) || now < 0) return false;
      const result = database.prepare(`
        UPDATE persona_memory_wake_word_jobs
        SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ?, last_reason = NULL
        WHERE account = ? AND id = ? AND status = 'pending' AND next_attempt_at <= ? AND expires_at > ?
      `).run(now, account, id, now, now);
      return result.changes === 1 || result.changes === 1n;
    },

    deferPersonaMemoryWakeWordJob(account, id, now, nextAttemptAt, reason) {
      if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(id) || id <= 0
        || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < now
        || !validReason(reason)) return false;
      const result = database.prepare(`
        UPDATE persona_memory_wake_word_jobs
        SET status = 'pending', next_attempt_at = ?, updated_at = ?, last_reason = ?
        WHERE account = ? AND id = ? AND status = 'sending'
      `).run(nextAttemptAt, now, reason, account, id);
      return result.changes === 1 || result.changes === 1n;
    },

    finishPersonaMemoryWakeWordJob(account, id, now) {
      if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(id) || id <= 0
        || !Number.isSafeInteger(now) || now < 0) return false;
      const result = database.prepare(`
        UPDATE persona_memory_wake_word_jobs
        SET status = 'scheduled', updated_at = ?, last_reason = NULL
        WHERE account = ? AND id = ? AND status = 'sending'
      `).run(now, account, id);
      return result.changes === 1 || result.changes === 1n;
    },

    skipPersonaMemoryWakeWordJob(account, id, now, reason) {
      if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(id) || id <= 0
        || !Number.isSafeInteger(now) || now < 0 || !validReason(reason)) return false;
      const result = database.prepare(`
        UPDATE persona_memory_wake_word_jobs
        SET status = 'skipped', updated_at = ?, last_reason = ?
        WHERE account = ? AND id = ? AND status = 'sending'
      `).run(now, reason, account, id);
      return result.changes === 1 || result.changes === 1n;
    },

    expirePersonaMemoryWakeWordJobs(account, now) {
      if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(now) || now < 0) return 0;
      const result = database.prepare(`
        UPDATE persona_memory_wake_word_jobs
        SET status = 'expired', updated_at = ?, last_reason = 'expired'
        WHERE account = ? AND status = 'pending' AND expires_at <= ?
      `).run(now, account, now);
      return Number(result.changes);
    },

    recoverPersonaMemoryWakeWordJobs(account, now) {
      if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(now) || now < 0) return 0;
      const result = database.prepare(`
        UPDATE persona_memory_wake_word_jobs
        SET status = 'pending', next_attempt_at = ?, updated_at = ?, last_reason = 'recovered'
        WHERE account = ? AND status = 'sending'
      `).run(now, now, account);
      return Number(result.changes);
    },
  };
}
