import type { DatabaseSync } from 'node:sqlite';
import type { PersonaDiarySourceEntry } from './persona-memory-repo.ts';

export type PersonaMemoryWakeFollowupStatus =
  | 'pending' | 'sending' | 'sent' | 'skipped' | 'needs_review' | 'expired';

export interface PersonaMemorySleepContextInput {
  account: number;
  sessionId: string;
  cycleKey: string;
  sourceEntries: PersonaDiarySourceEntry[];
  createdAt: number;
  expiresAt: number;
}

export interface PersonaMemorySleepContextRecord extends PersonaMemorySleepContextInput {}

export interface PersonaMemoryWakeFollowupInput {
  account: number;
  sessionId: string;
  cycleKey: string;
  messageIds: string[];
  mentionIds: number[];
  createdAt: number;
  expiresAt: number;
}

export interface PersonaMemoryWakeFollowupRecord extends PersonaMemoryWakeFollowupInput {
  id: number;
  status: PersonaMemoryWakeFollowupStatus;
  attemptCount: number;
  nextAttemptAt: number;
  updatedAt: number;
  lastReason: string | null;
}

export interface PersonaMemoryWakeRepository {
  upsertPersonaMemorySleepContext(input: PersonaMemorySleepContextInput): void;
  personaMemorySleepContext(account: number, sessionId: string, now: number): PersonaMemorySleepContextRecord | undefined;
  deleteExpiredPersonaMemorySleepContexts(account: number, now: number): number;
  enqueuePersonaMemoryWakeFollowup(input: PersonaMemoryWakeFollowupInput): number;
  listPendingPersonaMemoryWakeFollowups(account: number, now: number, limit: number): PersonaMemoryWakeFollowupRecord[];
  claimPersonaMemoryWakeFollowup(account: number, id: number, now: number): boolean;
  finishPersonaMemoryWakeFollowup(account: number, id: number, now: number): boolean;
  deferPersonaMemoryWakeFollowup(account: number, id: number, now: number, nextAttemptAt: number, reason: string): boolean;
  skipPersonaMemoryWakeFollowup(account: number, id: number, now: number, reason: string): boolean;
  reviewPersonaMemoryWakeFollowup(account: number, id: number, now: number, reason: string): boolean;
  recoverPersonaMemoryWakeFollowups(account: number, now: number): number;
  expirePersonaMemoryWakeFollowups(account: number, now: number): number;
}

const CYCLE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validScope(account: number, sessionId: string): boolean {
  return validId(account) && typeof sessionId === 'string'
    && sessionId.startsWith(`${account}:`) && sessionId.length <= 512;
}

function validSourceEntries(value: unknown, sessionId: string): value is PersonaDiarySourceEntry[] {
  return Array.isArray(value) && value.length <= 5 && value.every((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return record.sessionId === sessionId
      && typeof record.messageId === 'string' && record.messageId.length > 0 && record.messageId.length <= 512
      && typeof record.senderName === 'string' && record.senderName.length > 0 && record.senderName.length <= 120
      && typeof record.text === 'string' && record.text.length > 0 && record.text.length <= 2_000
      && typeof record.createdAt === 'number' && validTimestamp(record.createdAt)
      && (record.level === undefined || record.level === 'L0' || record.level === 'L1' || record.level === 'L2');
  });
}

function validMessageIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 1_000
    && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512);
}

function validMentionIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 1_000 && value.every(validId);
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000;
}

function numberValue(value: unknown, field: string): number {
  const converted = typeof value === 'bigint' ? Number(value) : value;
  if (typeof converted !== 'number' || !Number.isSafeInteger(converted)) {
    throw new Error(`数据库字段 ${field} 无效`);
  }
  return converted;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`数据库字段 ${field} 无效`);
  return value;
}

function sourceEntriesValue(value: unknown, sessionId: string): PersonaDiarySourceEntry[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stringValue(value, 'source_entries_json')) as unknown; }
  catch { throw new Error('数据库字段 source_entries_json 无效'); }
  if (!validSourceEntries(parsed, sessionId)) throw new Error('数据库字段 source_entries_json 范围无效');
  return parsed;
}

function stringIdsValue(value: unknown, field: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stringValue(value, field)) as unknown; }
  catch { throw new Error(`数据库字段 ${field} 无效`); }
  if (!validMessageIds(parsed)) throw new Error(`数据库字段 ${field} 范围无效`);
  return parsed;
}

function mentionIdsValue(value: unknown): number[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stringValue(value, 'mention_ids_json')) as unknown; }
  catch { throw new Error('数据库字段 mention_ids_json 无效'); }
  if (!validMentionIds(parsed)) throw new Error('数据库字段 mention_ids_json 范围无效');
  return parsed;
}

function contextRecord(row: Record<string, unknown>): PersonaMemorySleepContextRecord {
  const account = numberValue(row.account, 'account');
  const sessionId = stringValue(row.session_id, 'session_id');
  const cycleKey = stringValue(row.cycle_key, 'cycle_key');
  const createdAt = numberValue(row.created_at, 'created_at');
  const expiresAt = numberValue(row.expires_at, 'expires_at');
  if (!validScope(account, sessionId) || !CYCLE_KEY_PATTERN.test(cycleKey)
    || !validTimestamp(createdAt) || !validTimestamp(expiresAt) || expiresAt <= createdAt) {
    throw new Error('数据库人格睡眠上下文范围无效');
  }
  return {
    account,
    sessionId,
    cycleKey,
    sourceEntries: sourceEntriesValue(row.source_entries_json, sessionId),
    createdAt,
    expiresAt,
  };
}

function followupRecord(row: Record<string, unknown>): PersonaMemoryWakeFollowupRecord {
  const account = numberValue(row.account, 'account');
  const sessionId = stringValue(row.session_id, 'session_id');
  const cycleKey = stringValue(row.cycle_key, 'cycle_key');
  const status = stringValue(row.status, 'status');
  const createdAt = numberValue(row.created_at, 'created_at');
  const expiresAt = numberValue(row.expires_at, 'expires_at');
  const updatedAt = numberValue(row.updated_at, 'updated_at');
  const nextAttemptAt = numberValue(row.next_attempt_at, 'next_attempt_at');
  const lastReason = row.last_reason;
  if (!validScope(account, sessionId) || !CYCLE_KEY_PATTERN.test(cycleKey)
    || !['pending', 'sending', 'sent', 'skipped', 'needs_review', 'expired'].includes(status)
    || !validTimestamp(createdAt) || !validTimestamp(expiresAt) || expiresAt <= createdAt
    || !validTimestamp(updatedAt) || !validTimestamp(nextAttemptAt)
    || (lastReason !== null && (typeof lastReason !== 'string' || lastReason.length > 120))) {
    throw new Error('数据库人格补回复队列范围无效');
  }
  return {
    id: numberValue(row.id, 'id'),
    account,
    sessionId,
    cycleKey,
    messageIds: stringIdsValue(row.message_ids_json, 'message_ids_json'),
    mentionIds: mentionIdsValue(row.mention_ids_json),
    status: status as PersonaMemoryWakeFollowupStatus,
    attemptCount: numberValue(row.attempt_count, 'attempt_count'),
    nextAttemptAt,
    createdAt,
    expiresAt,
    updatedAt,
    lastReason: lastReason as string | null,
  };
}

export function createPersonaMemoryWakeRepository(database: DatabaseSync): PersonaMemoryWakeRepository {
  const selectContext = database.prepare(`
    SELECT account, session_id, cycle_key, source_entries_json, created_at, expires_at
    FROM persona_memory_sleep_contexts WHERE account = ? AND session_id = ? AND expires_at > ?
  `);
  const selectContextByCycle = database.prepare(`
    SELECT account, session_id, cycle_key, source_entries_json, created_at, expires_at
    FROM persona_memory_sleep_contexts WHERE account = ? AND session_id = ? AND cycle_key = ?
  `);
  const insertContext = database.prepare(`
    INSERT INTO persona_memory_sleep_contexts
      (account, session_id, cycle_key, source_entries_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (account, session_id, cycle_key) DO UPDATE SET
      source_entries_json = excluded.source_entries_json,
      created_at = MIN(persona_memory_sleep_contexts.created_at, excluded.created_at),
      expires_at = MIN(persona_memory_sleep_contexts.expires_at, excluded.expires_at)
  `);
  const deleteExpiredContexts = database.prepare(
    'DELETE FROM persona_memory_sleep_contexts WHERE account = ? AND expires_at <= ?',
  );
  const selectFollowupByCycle = database.prepare(`
    SELECT id, account, session_id, cycle_key, message_ids_json, mention_ids_json, status,
      attempt_count, next_attempt_at, created_at, expires_at, updated_at, last_reason
    FROM persona_memory_wake_followups WHERE account = ? AND session_id = ? AND cycle_key = ?
  `);
  const insertFollowup = database.prepare(`
    INSERT INTO persona_memory_wake_followups
      (account, session_id, cycle_key, message_ids_json, mention_ids_json, status,
        attempt_count, next_attempt_at, created_at, expires_at, updated_at, last_reason)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL)
    ON CONFLICT (account, session_id, cycle_key) DO UPDATE SET
      message_ids_json = excluded.message_ids_json,
      mention_ids_json = excluded.mention_ids_json,
      expires_at = MIN(persona_memory_wake_followups.expires_at, excluded.expires_at),
      updated_at = excluded.updated_at
    WHERE persona_memory_wake_followups.status = 'pending'
  `);
  const selectPending = database.prepare(`
    SELECT id, account, session_id, cycle_key, message_ids_json, mention_ids_json, status,
      attempt_count, next_attempt_at, created_at, expires_at, updated_at, last_reason
    FROM persona_memory_wake_followups
    WHERE account = ? AND status = 'pending' AND next_attempt_at <= ? AND expires_at > ?
    ORDER BY created_at, id LIMIT ?
  `);
  const claimFollowup = database.prepare(`
    UPDATE persona_memory_wake_followups
    SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ?, last_reason = NULL
    WHERE account = ? AND id = ? AND status = 'pending' AND next_attempt_at <= ? AND expires_at > ?
  `);
  const finishFollowup = database.prepare(`
    UPDATE persona_memory_wake_followups SET status = 'sent', updated_at = ?, last_reason = NULL
    WHERE account = ? AND id = ? AND status = 'sending'
  `);
  const deferFollowup = database.prepare(`
    UPDATE persona_memory_wake_followups
    SET status = CASE WHEN ? >= expires_at THEN 'expired' ELSE 'pending' END,
      next_attempt_at = ?, updated_at = ?, last_reason = ?
    WHERE account = ? AND id = ? AND status = 'sending'
  `);
  const skipFollowup = database.prepare(`
    UPDATE persona_memory_wake_followups SET status = 'skipped', updated_at = ?, last_reason = ?
    WHERE account = ? AND id = ? AND status = 'sending'
  `);
  const reviewFollowup = database.prepare(`
    UPDATE persona_memory_wake_followups SET status = 'needs_review', updated_at = ?, last_reason = ?
    WHERE account = ? AND id = ? AND status = 'sending'
  `);
  const recoverSending = database.prepare(`
    UPDATE persona_memory_wake_followups SET status = 'needs_review', updated_at = ?, last_reason = 'process-interrupted'
    WHERE account = ? AND status = 'sending'
  `);
  const expireFollowups = database.prepare(`
    UPDATE persona_memory_wake_followups SET status = 'expired', updated_at = ?, last_reason = 'expired'
    WHERE account = ? AND status = 'pending' AND expires_at <= ?
  `);

  return {
    upsertPersonaMemorySleepContext(input) {
      if (!validScope(input.account, input.sessionId) || !CYCLE_KEY_PATTERN.test(input.cycleKey)
        || !validSourceEntries(input.sourceEntries, input.sessionId)
        || !validTimestamp(input.createdAt) || !validTimestamp(input.expiresAt) || input.expiresAt <= input.createdAt) {
        throw new RangeError('人格睡眠上下文无效');
      }
      const existingRow = selectContextByCycle.get(input.account, input.sessionId, input.cycleKey) as Record<string, unknown> | undefined;
      const existing = existingRow ? contextRecord(existingRow) : undefined;
      const entries = new Map<string, PersonaDiarySourceEntry>();
      for (const entry of [...(existing?.sourceEntries ?? []), ...input.sourceEntries]) {
        entries.set(JSON.stringify([entry.sessionId, entry.messageId]), entry);
      }
      const merged = [...entries.values()].sort((first, second) => first.createdAt - second.createdAt
        || first.messageId.localeCompare(second.messageId)).slice(-5);
      insertContext.run(
        input.account,
        input.sessionId,
        input.cycleKey,
        JSON.stringify(merged),
        existing ? Math.min(existing.createdAt, input.createdAt) : input.createdAt,
        existing ? Math.min(existing.expiresAt, input.expiresAt) : input.expiresAt,
      );
    },

    personaMemorySleepContext(account, sessionId, now) {
      if (!validScope(account, sessionId) || !validTimestamp(now)) return undefined;
      const row = selectContext.get(account, sessionId, now) as Record<string, unknown> | undefined;
      return row ? contextRecord(row) : undefined;
    },

    deleteExpiredPersonaMemorySleepContexts(account, now) {
      if (!validId(account) || !validTimestamp(now)) throw new RangeError('人格睡眠上下文清理范围无效');
      return Number(deleteExpiredContexts.run(account, now).changes);
    },

    enqueuePersonaMemoryWakeFollowup(input) {
      if (!validScope(input.account, input.sessionId) || !CYCLE_KEY_PATTERN.test(input.cycleKey)
        || !validMessageIds(input.messageIds) || !validMentionIds(input.mentionIds)
        || !validTimestamp(input.createdAt) || !validTimestamp(input.expiresAt) || input.expiresAt <= input.createdAt) {
        throw new RangeError('人格补回复队列记录无效');
      }
      const existingRow = selectFollowupByCycle.get(input.account, input.sessionId, input.cycleKey) as Record<string, unknown> | undefined;
      const existing = existingRow ? followupRecord(existingRow) : undefined;
      const messageIds = [...new Set([...(existing?.messageIds ?? []), ...input.messageIds])];
      const mentionIds = [...new Set([...(existing?.mentionIds ?? []), ...input.mentionIds])];
      if (!validMessageIds(messageIds) || !validMentionIds(mentionIds)) throw new RangeError('人格补回复队列范围过大');
      insertFollowup.run(
        input.account,
        input.sessionId,
        input.cycleKey,
        JSON.stringify(messageIds),
        JSON.stringify(mentionIds),
        Math.min(existing?.nextAttemptAt ?? input.createdAt, input.createdAt),
        existing ? Math.min(existing.createdAt, input.createdAt) : input.createdAt,
        existing ? Math.min(existing.expiresAt, input.expiresAt) : input.expiresAt,
        input.createdAt,
      );
      const row = selectFollowupByCycle.get(input.account, input.sessionId, input.cycleKey) as Record<string, unknown> | undefined;
      if (!row) throw new Error('人格补回复队列写入失败');
      return numberValue(row.id, 'id');
    },

    listPendingPersonaMemoryWakeFollowups(account, now, limit) {
      if (!validId(account) || !validTimestamp(now) || !validLimit(limit)) return [];
      return (selectPending.all(account, now, now, limit) as Array<Record<string, unknown>>).map(followupRecord);
    },

    claimPersonaMemoryWakeFollowup(account, id, now) {
      if (!validId(account) || !validId(id) || !validTimestamp(now)) return false;
      return Number(claimFollowup.run(now, account, id, now, now).changes) === 1;
    },

    finishPersonaMemoryWakeFollowup(account, id, now) {
      if (!validId(account) || !validId(id) || !validTimestamp(now)) return false;
      return Number(finishFollowup.run(now, account, id).changes) === 1;
    },

    deferPersonaMemoryWakeFollowup(account, id, now, nextAttemptAt, reason) {
      if (!validId(account) || !validId(id) || !validTimestamp(now) || !validTimestamp(nextAttemptAt)
        || typeof reason !== 'string' || reason.length < 1 || reason.length > 120) return false;
      return Number(deferFollowup.run(nextAttemptAt, nextAttemptAt, now, reason, account, id).changes) === 1;
    },

    skipPersonaMemoryWakeFollowup(account, id, now, reason) {
      if (!validId(account) || !validId(id) || !validTimestamp(now)
        || typeof reason !== 'string' || reason.length < 1 || reason.length > 120) return false;
      return Number(skipFollowup.run(now, reason, account, id).changes) === 1;
    },

    reviewPersonaMemoryWakeFollowup(account, id, now, reason) {
      if (!validId(account) || !validId(id) || !validTimestamp(now)
        || typeof reason !== 'string' || reason.length < 1 || reason.length > 120) return false;
      return Number(reviewFollowup.run(now, reason, account, id).changes) === 1;
    },

    recoverPersonaMemoryWakeFollowups(account, now) {
      if (!validId(account) || !validTimestamp(now)) return 0;
      return Number(recoverSending.run(now, account).changes);
    },

    expirePersonaMemoryWakeFollowups(account, now) {
      if (!validId(account) || !validTimestamp(now)) return 0;
      return Number(expireFollowups.run(now, account, now).changes);
    },
  };
}
