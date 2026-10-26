import type { DatabaseSync } from 'node:sqlite';
import { createPersonaEventMemoRepository, type PersonaEventMemoRepository } from './persona-memory-event-repo.ts';
import { createMemoryCursorRepository, type PersonaMemoryCursorRepository } from './memory-cursor-repo.ts';
import { createPersonaMemoryWakeRepository, type PersonaMemoryWakeRepository } from './persona-memory-wake-repo.ts';

export interface PersonaMemoInput {
  account: number;
  sessionId: string;
  messageId: string;
  senderId: number;
  senderName: string;
  isSelf: boolean;
  text: string;
  createdAt: number;
}

export interface PersonaMemoRecord extends PersonaMemoInput {
  id: number;
  processedCycleKey: string | null;
}

export type PersonaMemoryRunStatus = 'running' | 'done' | 'budget' | 'failed' | 'empty' | 'partial';

export interface PersonaMemoryRunRecord {
  account: number;
  cycleKey: string;
  status: PersonaMemoryRunStatus;
  reason: string | null;
  memoCount: number;
  processedCount: number;
  startedAt: number;
  finishedAt: number | null;
}

export interface PersonaMemoryRunResultInput {
  account: number;
  cycleKey: string;
  status: Exclude<PersonaMemoryRunStatus, 'running'>;
  reason: string | null;
  processedCount: number;
  finishedAt: number;
}

export interface PersonaMemoryRunResumeInput {
  account: number;
  cycleKey: string;
  memoCount: number;
  processedCount: number;
}

export interface PersonaDiaryInput {
  account: number;
  cycleKey: string;
  text: string;
  sourceEntries?: PersonaDiarySourceEntry[];
  sourceMemoIds?: number[];
  sourceCount: number;
  createdAt: number;
  visibleToAni?: boolean;
}

export interface PersonaDiarySourceEntry {
  sessionId: string;
  messageId: string;
  senderName: string;
  text: string;
  createdAt: number;
  level?: 'L0' | 'L1' | 'L2';
}

export interface PersonaDiaryRecord extends Required<PersonaDiaryInput> {
  id: number;
}

export interface PersonaMemoryRepository extends PersonaMemoryCursorRepository, PersonaEventMemoRepository, PersonaMemoryWakeRepository {
  insertPersonaMemo(memo: PersonaMemoInput): boolean;
  listPersonaMemos(account: number, limit: number): PersonaMemoRecord[];
  listPendingPersonaMemos(account: number, limit: number): PersonaMemoRecord[];
  markPersonaMemosProcessed(account: number, memoIds: readonly number[], cycleKey: string): number;
  startPersonaMemoryRun(input: Pick<PersonaMemoryRunRecord, 'account' | 'cycleKey' | 'memoCount' | 'startedAt'>): boolean;
  resumePersonaMemoryRun(input: PersonaMemoryRunResumeInput): boolean;
  countProcessedPersonaMemos(account: number, cycleKey: string): number;
  finishPersonaMemoryRun(input: PersonaMemoryRunResultInput): void;
  personaMemoryRun(account: number, cycleKey: string): PersonaMemoryRunRecord | undefined;
  personaDiary(account: number, cycleKey: string): PersonaDiaryRecord | undefined;
  insertPersonaDiary(diary: PersonaDiaryInput): number;
  listPersonaDiaries(account: number, limit: number): PersonaDiaryRecord[];
  listVisiblePersonaDiaries(account: number, limit: number): PersonaDiaryRecord[];
  listVisiblePersonaDiariesInRange(account: number, from: number, to: number): PersonaDiaryRecord[];
  setPersonaDiaryVisibility(account: number, id: number, visibleToAni: boolean): boolean;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    if (Number.isSafeInteger(converted)) return converted;
  }
  throw new Error(`数据库字段 ${field} 不是安全整数`);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function limitValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new RangeError('人格记忆查询数量无效');
  return value;
}

function validCycleKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function validDiarySourceEntries(value: unknown): value is PersonaDiarySourceEntry[] {
  if (!Array.isArray(value) || value.length > 2_000) return false;
  return value.every((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return typeof record.sessionId === 'string' && record.sessionId.length > 0 && record.sessionId.length <= 512
      && typeof record.messageId === 'string' && record.messageId.length > 0 && record.messageId.length <= 512
      && typeof record.senderName === 'string' && record.senderName.length > 0 && record.senderName.length <= 120
      && typeof record.text === 'string' && record.text.length > 0 && record.text.length <= 2_000
      && typeof record.createdAt === 'number' && Number.isSafeInteger(record.createdAt) && record.createdAt >= 0
      && (record.level === undefined || record.level === 'L0' || record.level === 'L1' || record.level === 'L2');
  });
}

function validSourceMemoIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 2_000
    && value.every((id) => Number.isSafeInteger(id) && (id as number) > 0);
}

function memoRecord(row: Record<string, unknown>): PersonaMemoRecord {
  const isSelf = numberValue(row.is_self, 'is_self');
  if (isSelf !== 0 && isSelf !== 1) throw new Error('数据库字段 is_self 无效');
  const processedCycleKey = row.processed_cycle_key;
  if (processedCycleKey !== null && typeof processedCycleKey !== 'string') {
    throw new Error('数据库字段 processed_cycle_key 无效');
  }
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    sessionId: stringValue(row.session_id, 'session_id'),
    messageId: stringValue(row.message_id, 'message_id'),
    senderId: numberValue(row.sender_id, 'sender_id'),
    senderName: stringValue(row.sender_name, 'sender_name'),
    isSelf: isSelf === 1,
    text: stringValue(row.text, 'text'),
    createdAt: numberValue(row.created_at, 'created_at'),
    processedCycleKey,
  };
}

function diaryRecord(row: Record<string, unknown>): PersonaDiaryRecord {
  const visibleToAni = numberValue(row.visible_to_ani, 'visible_to_ani');
  if (visibleToAni !== 0 && visibleToAni !== 1) throw new Error('数据库字段 visible_to_ani 无效');
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    cycleKey: stringValue(row.cycle_key, 'cycle_key'),
    text: stringValue(row.text, 'text'),
    sourceEntries: sourceEntriesValue(row.source_entries_json),
    sourceMemoIds: sourceMemoIdsValue(row.source_memo_ids_json),
    visibleToAni: visibleToAni === 1,
    sourceCount: numberValue(row.source_count, 'source_count'),
    createdAt: numberValue(row.created_at, 'created_at'),
  };
}

function sourceMemoIdsValue(value: unknown): number[] {
  if (typeof value !== 'string') throw new Error('数据库字段 source_memo_ids_json 不是文本');
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error('数据库字段 source_memo_ids_json 无效'); }
  if (!Array.isArray(parsed) || parsed.length > 2_000
    || parsed.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('数据库字段 source_memo_ids_json 无效');
  }
  return [...new Set(parsed as number[])].sort((first, second) => first - second);
}

function sourceEntriesValue(value: unknown): PersonaDiarySourceEntry[] {
  if (typeof value !== 'string') throw new Error('数据库字段 source_entries_json 不是文本');
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error('数据库字段 source_entries_json 无效'); }
  if (!Array.isArray(parsed) || parsed.length > 2_000) throw new Error('数据库字段 source_entries_json 无效');
  return parsed.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('数据库日记来源无效');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.sessionId !== 'string' || record.sessionId.length < 1 || record.sessionId.length > 512
      || typeof record.messageId !== 'string' || record.messageId.length < 1 || record.messageId.length > 512
      || typeof record.senderName !== 'string' || record.senderName.length < 1 || record.senderName.length > 120
      || typeof record.text !== 'string' || record.text.length < 1 || record.text.length > 2_000
      || typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || (record.level !== undefined && record.level !== 'L0' && record.level !== 'L1' && record.level !== 'L2')) {
      throw new Error('数据库日记来源无效');
    }
    return {
      sessionId: record.sessionId,
      messageId: record.messageId,
      senderName: record.senderName,
      text: record.text,
      createdAt: record.createdAt,
      ...(record.level === undefined ? {} : { level: record.level }),
    };
  });
}

function memoryRunRecord(row: Record<string, unknown>): PersonaMemoryRunRecord {
  const status = stringValue(row.status, 'status');
  if (!['running', 'done', 'budget', 'failed', 'empty', 'partial'].includes(status)) {
    throw new Error('数据库字段 status 无效');
  }
  const reason = row.reason;
  if (reason !== null && typeof reason !== 'string') throw new Error('数据库字段 reason 无效');
  return {
    account: numberValue(row.account, 'account'),
    cycleKey: stringValue(row.cycle_key, 'cycle_key'),
    status: status as PersonaMemoryRunStatus,
    reason,
    memoCount: numberValue(row.memo_count, 'memo_count'),
    processedCount: numberValue(row.processed_count, 'processed_count'),
    startedAt: numberValue(row.started_at, 'started_at'),
    finishedAt: row.finished_at === null ? null : numberValue(row.finished_at, 'finished_at'),
  };
}

export function createPersonaMemoryRepository(database: DatabaseSync): PersonaMemoryRepository {
  const eventMemos = createPersonaEventMemoRepository(database);
  const memoryCursors = createMemoryCursorRepository(database);
  const wakeMemory = createPersonaMemoryWakeRepository(database);
  const insertMemo = database.prepare(`
    INSERT OR IGNORE INTO persona_memos_legacy_v26
      (account, session_id, message_id, sender_id, sender_name, is_self, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMemos = database.prepare(`
    SELECT id, account, session_id, message_id, sender_id, sender_name, is_self, text, created_at, processed_cycle_key
    FROM persona_memos_legacy_v26 WHERE account = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `);
  const selectPendingMemos = database.prepare(`
    SELECT id, account, session_id, message_id, sender_id, sender_name, is_self, text, created_at, processed_cycle_key
    FROM persona_memos_legacy_v26 WHERE account = ? AND processed_cycle_key IS NULL
    ORDER BY created_at, id LIMIT ?
  `);

  const insertMemoryRun = database.prepare(`
    INSERT OR IGNORE INTO persona_memory_runs
      (account, cycle_key, status, reason, memo_count, processed_count, started_at, finished_at)
    VALUES (?, ?, 'running', NULL, ?, 0, ?, NULL)
  `);
  const updateMemoryRun = database.prepare(`
    UPDATE persona_memory_runs
    SET status = ?, reason = ?, processed_count = ?, finished_at = ?
    WHERE account = ? AND cycle_key = ? AND status = 'running'
  `);
  const resumeMemoryRun = database.prepare(`
    UPDATE persona_memory_runs
    SET status = 'running', memo_count = ?, processed_count = ?, reason = NULL, finished_at = NULL
    WHERE account = ? AND cycle_key = ?
      AND status IN ('running', 'done', 'budget', 'failed', 'empty', 'partial')
  `);
  const countProcessedMemos = database.prepare(`
    SELECT COUNT(*) AS count FROM persona_memos_legacy_v26
    WHERE account = ? AND processed_cycle_key = ?
  `);
  const selectMemoryRun = database.prepare(`
    SELECT account, cycle_key, status, reason, memo_count, processed_count, started_at, finished_at
    FROM persona_memory_runs WHERE account = ? AND cycle_key = ?
  `);
  const insertDiary = database.prepare(`
    INSERT INTO persona_diaries
      (account, cycle_key, text, source_entries_json, source_memo_ids_json, visible_to_ani, source_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account, cycle_key) DO UPDATE SET
      text = excluded.text,
      source_entries_json = excluded.source_entries_json,
      source_memo_ids_json = excluded.source_memo_ids_json,
      visible_to_ani = excluded.visible_to_ani,
      source_count = excluded.source_count,
      created_at = excluded.created_at
  `);
  const selectDiaryId = database.prepare('SELECT id FROM persona_diaries WHERE account = ? AND cycle_key = ?');
  const selectDiaryByCycle = database.prepare(`
    SELECT id, account, cycle_key, text, source_entries_json, source_memo_ids_json, visible_to_ani, source_count, created_at
    FROM persona_diaries WHERE account = ? AND cycle_key = ?
  `);
  const selectDiaries = database.prepare(`
    SELECT id, account, cycle_key, text, source_entries_json, source_memo_ids_json, visible_to_ani, source_count, created_at
    FROM persona_diaries WHERE account = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `);
  const selectVisibleDiaries = database.prepare(`
    SELECT id, account, cycle_key, text, source_entries_json, source_memo_ids_json, visible_to_ani, source_count, created_at
    FROM persona_diaries WHERE account = ? AND visible_to_ani = 1 ORDER BY created_at DESC, id DESC LIMIT ?
  `);
  const selectVisibleDiariesInRange = database.prepare(`
    SELECT id, account, cycle_key, text, source_entries_json, source_memo_ids_json, visible_to_ani, source_count, created_at
    FROM persona_diaries
    WHERE account = ? AND visible_to_ani = 1 AND created_at >= ? AND created_at <= ?
    ORDER BY created_at DESC, id DESC
  `);
  const setDiaryVisibility = database.prepare(
    'UPDATE persona_diaries SET visible_to_ani = ? WHERE account = ? AND id = ?',
  );

  return {
    ...eventMemos,
    ...memoryCursors,
    ...wakeMemory,
    insertPersonaMemo(memo) {
      if (!validId(memo.account) || !validId(memo.senderId)
        || typeof memo.sessionId !== 'string' || memo.sessionId.length < 1 || memo.sessionId.length > 512
        || typeof memo.messageId !== 'string' || memo.messageId.length < 1 || memo.messageId.length > 512
        || typeof memo.senderName !== 'string' || memo.senderName.length < 1 || memo.senderName.length > 120
        || typeof memo.isSelf !== 'boolean' || typeof memo.text !== 'string'
        || memo.text.length < 1 || memo.text.length > 2_000
        || !Number.isSafeInteger(memo.createdAt) || memo.createdAt < 0) {
        throw new RangeError('人格 memo 无效');
      }
      const result = insertMemo.run(
        memo.account,
        memo.sessionId,
        memo.messageId,
        memo.senderId,
        memo.senderName,
        memo.isSelf ? 1 : 0,
        memo.text,
        memo.createdAt,
      );
      return result.changes === 1 || result.changes === 1n;
    },

    listPersonaMemos(account, limit) {
      if (!validId(account)) return [];
      const rows = selectMemos.all(account, limitValue(limit)) as Array<Record<string, unknown>>;
      return rows.map(memoRecord);
    },

    listPendingPersonaMemos(account, limit) {
      if (!validId(account)) return [];
      const rows = selectPendingMemos.all(account, limitValue(limit)) as Array<Record<string, unknown>>;
      return rows.map(memoRecord);
    },

    markPersonaMemosProcessed(account, memoIds, cycleKey) {
      if (!validId(account) || !Array.isArray(memoIds) || !validCycleKey(cycleKey)
        || memoIds.some((id) => !validId(id))) {
        throw new RangeError('persona memo 整理游标无效');
      }
      const uniqueIds = [...new Set(memoIds)];
      let changed = 0;
      for (let offset = 0; offset < uniqueIds.length; offset += 500) {
        const batch = uniqueIds.slice(offset, offset + 500);
        if (batch.length === 0) continue;
        const placeholders = batch.map(() => '?').join(', ');
        const statement = database.prepare(`
          UPDATE persona_memos_legacy_v26 SET processed_cycle_key = ?
          WHERE account = ? AND processed_cycle_key IS NULL AND id IN (${placeholders})
        `);
        const result = statement.run(cycleKey, account, ...batch);
        changed += Number(result.changes);
      }
      return changed;
    },

    startPersonaMemoryRun(input) {
      if (!validId(input.account) || !validCycleKey(input.cycleKey)
        || !Number.isSafeInteger(input.memoCount) || input.memoCount < 0
        || !Number.isSafeInteger(input.startedAt) || input.startedAt < 0) {
        throw new RangeError('人格记忆整理记录无效');
      }
      const result = insertMemoryRun.run(input.account, input.cycleKey, input.memoCount, input.startedAt);
      return result.changes === 1 || result.changes === 1n;
    },

    resumePersonaMemoryRun(input) {
      if (!validId(input.account) || !validCycleKey(input.cycleKey)
        || !Number.isSafeInteger(input.memoCount) || input.memoCount < 0
        || !Number.isSafeInteger(input.processedCount) || input.processedCount < 0
        || input.processedCount > input.memoCount) {
        throw new RangeError('人格记忆恢复记录无效');
      }
      const result = resumeMemoryRun.run(
        input.memoCount,
        input.processedCount,
        input.account,
        input.cycleKey,
      );
      return result.changes === 1 || result.changes === 1n;
    },

    countProcessedPersonaMemos(account, cycleKey) {
      if (!validId(account) || !validCycleKey(cycleKey)) return 0;
      const row = countProcessedMemos.get(account, cycleKey) as Record<string, unknown> | undefined;
      return row ? numberValue(row.count, 'count') : 0;
    },

    finishPersonaMemoryRun(input) {
      if (!validId(input.account) || !validCycleKey(input.cycleKey)
        || !['done', 'budget', 'failed', 'empty', 'partial'].includes(input.status)
        || (input.reason !== null && (typeof input.reason !== 'string' || input.reason.length > 120))
        || !Number.isSafeInteger(input.processedCount) || input.processedCount < 0
        || !Number.isSafeInteger(input.finishedAt) || input.finishedAt < 0) {
        throw new RangeError('人格记忆整理结果无效');
      }
      updateMemoryRun.run(
        input.status,
        input.reason,
        input.processedCount,
        input.finishedAt,
        input.account,
        input.cycleKey,
      );
    },

    personaMemoryRun(account, cycleKey) {
      if (!validId(account) || !validCycleKey(cycleKey)) return undefined;
      const row = selectMemoryRun.get(account, cycleKey) as Record<string, unknown> | undefined;
      return row ? memoryRunRecord(row) : undefined;
    },

    personaDiary(account, cycleKey) {
      if (!validId(account) || !validCycleKey(cycleKey)) return undefined;
      const row = selectDiaryByCycle.get(account, cycleKey) as Record<string, unknown> | undefined;
      return row ? diaryRecord(row) : undefined;
    },

    insertPersonaDiary(diary) {
      const sourceEntries = diary.sourceEntries ?? [];
      const sourceMemoIds = diary.sourceMemoIds ?? [];
      if (!validId(diary.account) || !validCycleKey(diary.cycleKey)
        || typeof diary.text !== 'string' || diary.text.length < 1 || diary.text.length > 4_000
        || !validDiarySourceEntries(sourceEntries) || !validSourceMemoIds(sourceMemoIds)
        || !Number.isSafeInteger(diary.sourceCount) || diary.sourceCount < 0
        || !Number.isSafeInteger(diary.createdAt) || diary.createdAt < 0
        || (diary.visibleToAni !== undefined && typeof diary.visibleToAni !== 'boolean')) {
        throw new RangeError('人格日记无效');
      }
      insertDiary.run(
        diary.account,
        diary.cycleKey,
        diary.text,
        JSON.stringify(sourceEntries),
        JSON.stringify([...new Set(sourceMemoIds)].sort((first, second) => first - second)),
        diary.visibleToAni === false ? 0 : 1,
        diary.sourceCount,
        diary.createdAt,
      );
      const row = selectDiaryId.get(diary.account, diary.cycleKey) as Record<string, unknown> | undefined;
      if (!row) throw new Error('人格日记写入失败');
      return numberValue(row.id, 'id');
    },

    listPersonaDiaries(account, limit) {
      if (!validId(account)) return [];
      const rows = selectDiaries.all(account, limitValue(limit)) as Array<Record<string, unknown>>;
      return rows.map(diaryRecord);
    },

    listVisiblePersonaDiaries(account, limit) {
      if (!validId(account)) return [];
      const rows = selectVisibleDiaries.all(account, limitValue(limit)) as Array<Record<string, unknown>>;
      return rows.map(diaryRecord);
    },

    listVisiblePersonaDiariesInRange(account, from, to) {
      if (!validId(account) || !Number.isSafeInteger(from) || from < 0
        || !Number.isSafeInteger(to) || to < from) return [];
      const rows = selectVisibleDiariesInRange.all(account, from, to) as Array<Record<string, unknown>>;
      return rows.map(diaryRecord);
    },

    setPersonaDiaryVisibility(account, id, visibleToAni) {
      if (!validId(account) || !validId(id) || typeof visibleToAni !== 'boolean') return false;
      const result = setDiaryVisibility.run(visibleToAni ? 1 : 0, account, id);
      return result.changes === 1 || result.changes === 1n;
    },
  };
}
