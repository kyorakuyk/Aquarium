import type { DatabaseSync } from 'node:sqlite';

export type PersonaEventMemoLevel = 'L0' | 'L1' | 'L2';

export interface PersonaEventMemoInput {
  account: number;
  sessionId: string;
  eventId: number | null;
  title: string;
  summary: string;
  participantIds: number[];
  startMessageId: string;
  endMessageId: string;
  level: PersonaEventMemoLevel;
  createdAt: number;
}

export interface PersonaEventMemoRecord extends PersonaEventMemoInput {
  id: number;
  diaryCycle: string | null;
}

export interface PersonaMemoryTailInput {
  messageId: string;
  createdAt: number;
}

export interface PersonaMemoryTailRecord extends PersonaMemoryTailInput {
  account: number;
  sessionId: string;
  diaryCycle: string | null;
}

export interface PersonaEventMemoRepository {
  insertPersonaEventMemo(memo: PersonaEventMemoInput): boolean;
  listPersonaEventMemos(account: number, limit: number): PersonaEventMemoRecord[];
  listUnassignedPersonaEventMemos(account: number, from: number, to: number, limit: number): PersonaEventMemoRecord[];
  assignPersonaEventMemosToDiary(account: number, memoIds: readonly number[], cycleKey: string): number;
  savePersonaMemoryTailMessages(input: {
    account: number; sessionId: string; messages: readonly PersonaMemoryTailInput[];
  }): number;
  listPersonaMemoryTailMessages(account: number, limit: number): PersonaMemoryTailRecord[];
  assignPersonaMemoryTailMessagesToDiary(
    account: number, sessionId: string, messageIds: readonly string[], cycleKey: string,
  ): number;
  deletePersonaMemoryTailMessagesBefore(account: number, cutoff: number): number;
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validText(value: string, field: string, max: number): string {
  const text = value.trim();
  const length = Array.from(text).length;
  if (length < 1 || length > max) throw new RangeError(`${field} 长度必须为 1–${max} 个字符`);
  return text;
}

function validLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new RangeError('人格 memo 查询数量无效');
  return value;
}

function validCycleKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function numberValue(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) throw new Error(`数据库字段 ${field} 无效`);
  return number;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`数据库字段 ${field} 无效`);
  return value;
}

function participantIdsValue(value: unknown): number[] {
  const parsed: unknown = JSON.parse(stringValue(value, 'participants_json'));
  if (!Array.isArray(parsed) || parsed.some((item) => !validId(item))) {
    throw new Error('数据库字段 participants_json 无效');
  }
  return [...new Set(parsed as number[])].sort((first, second) => first - second);
}

function memoRecord(row: Record<string, unknown>): PersonaEventMemoRecord {
  const level = stringValue(row.level, 'level');
  if (level !== 'L0' && level !== 'L1' && level !== 'L2') throw new Error('数据库字段 level 无效');
  const diaryCycle = row.diary_cycle;
  if (diaryCycle !== null && typeof diaryCycle !== 'string') throw new Error('数据库字段 diary_cycle 无效');
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    sessionId: stringValue(row.session_id, 'session_id'),
    eventId: row.event_id === null ? null : numberValue(row.event_id, 'event_id'),
    title: stringValue(row.title, 'title'),
    summary: stringValue(row.summary, 'summary'),
    participantIds: participantIdsValue(row.participants_json),
    startMessageId: stringValue(row.start_msg, 'start_msg'),
    endMessageId: stringValue(row.end_msg, 'end_msg'),
    level,
    createdAt: numberValue(row.created_at, 'created_at'),
    diaryCycle,
  };
}

function tailRecord(row: Record<string, unknown>): PersonaMemoryTailRecord {
  const diaryCycle = row.diary_cycle;
  if (diaryCycle !== null && typeof diaryCycle !== 'string') throw new Error('数据库字段 tail.diary_cycle 无效');
  return {
    account: numberValue(row.account, 'account'),
    sessionId: stringValue(row.session_id, 'session_id'),
    messageId: stringValue(row.message_id, 'message_id'),
    createdAt: numberValue(row.created_at, 'created_at'),
    diaryCycle,
  };
}

export function createPersonaEventMemoRepository(database: DatabaseSync): PersonaEventMemoRepository {
  const insertMemo = database.prepare(`
    INSERT OR IGNORE INTO persona_memos
      (account, session_id, event_id, title, summary, participants_json, start_msg, end_msg, level, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMemos = database.prepare(`
    SELECT id, account, session_id, event_id, title, summary, participants_json, start_msg, end_msg,
      level, created_at, diary_cycle
    FROM persona_memos WHERE account = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `);
  const selectUnassigned = database.prepare(`
    SELECT id, account, session_id, event_id, title, summary, participants_json, start_msg, end_msg,
      level, created_at, diary_cycle
    FROM persona_memos
    WHERE account = ? AND diary_cycle IS NULL AND created_at >= ? AND created_at <= ?
    ORDER BY created_at, id LIMIT ?
  `);
  const insertTail = database.prepare(`
    INSERT OR IGNORE INTO persona_memory_tails (account, session_id, message_id, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const selectTails = database.prepare(`
    SELECT account, session_id, message_id, created_at, diary_cycle
    FROM persona_memory_tails WHERE account = ? AND diary_cycle IS NULL
    ORDER BY created_at, session_id, message_id LIMIT ?
  `);

  return {
    insertPersonaEventMemo(memo) {
      if (!validId(memo.account) || typeof memo.sessionId !== 'string'
        || !memo.sessionId.startsWith(`${memo.account}:`) || memo.sessionId.length > 512
        || (memo.eventId !== null && !validId(memo.eventId))
        || !Array.isArray(memo.participantIds) || memo.participantIds.some((id) => !validId(id))
        || !['L0', 'L1', 'L2'].includes(memo.level)
        || !Number.isSafeInteger(memo.createdAt) || memo.createdAt < 0
        || typeof memo.startMessageId !== 'string' || memo.startMessageId.length < 1 || memo.startMessageId.length > 512
        || typeof memo.endMessageId !== 'string' || memo.endMessageId.length < 1 || memo.endMessageId.length > 512) {
        throw new RangeError('人格事件 memo 无效');
      }
      const title = validText(memo.title, 'memo 标题', 16);
      const summary = validText(memo.summary, 'memo 摘要', 120);
      const participants = [...new Set(memo.participantIds)].sort((first, second) => first - second);
      const result = insertMemo.run(
        memo.account, memo.sessionId, memo.eventId, title, summary, JSON.stringify(participants),
        memo.startMessageId, memo.endMessageId, memo.level, memo.createdAt,
      );
      return result.changes === 1 || result.changes === 1n;
    },

    listPersonaEventMemos(account, limit) {
      if (!validId(account)) return [];
      return (selectMemos.all(account, validLimit(limit)) as Array<Record<string, unknown>>).map(memoRecord);
    },

    listUnassignedPersonaEventMemos(account, from, to, limit) {
      if (!validId(account) || !Number.isSafeInteger(from) || from < 0
        || !Number.isSafeInteger(to) || to < from) return [];
      return (selectUnassigned.all(account, from, to, validLimit(limit)) as Array<Record<string, unknown>>).map(memoRecord);
    },

    assignPersonaEventMemosToDiary(account, memoIds, cycleKey) {
      if (!validId(account) || !Array.isArray(memoIds) || memoIds.some((id) => !validId(id))
        || !validCycleKey(cycleKey)) throw new RangeError('人格 memo 日记归属无效');
      let changed = 0;
      const ids = [...new Set(memoIds)];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        if (batch.length === 0) continue;
        const placeholders = batch.map(() => '?').join(', ');
        changed += Number(database.prepare(`
          UPDATE persona_memos SET diary_cycle = ?
          WHERE account = ? AND diary_cycle IS NULL AND id IN (${placeholders})
        `).run(cycleKey, account, ...batch).changes);
      }
      return changed;
    },

    savePersonaMemoryTailMessages(input) {
      if (!validId(input.account) || typeof input.sessionId !== 'string'
        || !input.sessionId.startsWith(`${input.account}:`) || input.sessionId.length > 512
        || !Array.isArray(input.messages) || input.messages.length > 10_000) {
        throw new RangeError('人格记忆零散尾巴范围无效');
      }
      let inserted = 0;
      for (const message of input.messages) {
        if (typeof message.messageId !== 'string' || message.messageId.length < 1 || message.messageId.length > 512
          || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0) {
          throw new RangeError('人格记忆零散尾巴消息无效');
        }
        const result = insertTail.run(input.account, input.sessionId, message.messageId, message.createdAt);
        inserted += Number(result.changes);
      }
      return inserted;
    },

    listPersonaMemoryTailMessages(account, limit) {
      if (!validId(account)) return [];
      return (selectTails.all(account, validLimit(limit)) as Array<Record<string, unknown>>).map(tailRecord);
    },

    assignPersonaMemoryTailMessagesToDiary(account, sessionId, messageIds, cycleKey) {
      if (!validId(account) || typeof sessionId !== 'string' || !sessionId.startsWith(`${account}:`)
        || !Array.isArray(messageIds) || messageIds.some((id) => typeof id !== 'string' || id.length < 1)
        || !validCycleKey(cycleKey)) throw new RangeError('人格记忆零散尾巴日记归属无效');
      let changed = 0;
      const ids = [...new Set(messageIds)];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const batch = ids.slice(offset, offset + 500);
        if (batch.length === 0) continue;
        const placeholders = batch.map(() => '?').join(', ');
        changed += Number(database.prepare(`
          UPDATE persona_memory_tails SET diary_cycle = ?
          WHERE account = ? AND session_id = ? AND diary_cycle IS NULL AND message_id IN (${placeholders})
        `).run(cycleKey, account, sessionId, ...batch).changes);
      }
      return changed;
    },

    deletePersonaMemoryTailMessagesBefore(account, cutoff) {
      if (!validId(account) || !Number.isSafeInteger(cutoff) || cutoff < 0) return 0;
      const result = database.prepare(
        'DELETE FROM persona_memory_tails WHERE account = ? AND created_at < ?',
      ).run(account, cutoff);
      return Number(result.changes);
    },
  };
}
