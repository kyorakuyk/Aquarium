import type { DatabaseSync } from 'node:sqlite';

export interface PersonaMemoryCursorRecord {
  account: number;
  sessionId: string;
  organizedUntilMessageTime: number | null;
  organizedUntilMessageRowId?: number | null;
  openSegmentStart: number | null;
}

export interface PersonaMemoryCursorSummary extends PersonaMemoryCursorRecord {
  pendingMessageCount: number;
  latestPendingMessageTime: number | null;
}

export interface PersonaMemoryCursorMessage {
  rowId: number;
  messageId: string;
  senderId: number;
  senderName: string;
  isSelf: boolean;
  plainText: string;
  segments: unknown[];
  time: number;
}

export interface PersonaMemoryCursorRepository {
  personaMemoryCursor(account: number, sessionId: string): PersonaMemoryCursorRecord | undefined;
  savePersonaMemoryCursor(cursor: PersonaMemoryCursorRecord): void;
  listPersonaMemoryPendingMessages(account: number, sessionId: string): PersonaMemoryCursorMessage[];
  listPersonaMemoryCursorSummaries(account: number): PersonaMemoryCursorSummary[];
  deleteOrganizedPersonaMemoryMessagesBefore(account: number, cutoff: number): number;
  clearOrganizedPersonaMemoryMessages(account: number, sessionId?: string): number;
}

function integerValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    if (Number.isSafeInteger(converted)) return converted;
  }
  throw new Error(`数据库字段 ${field} 不是安全整数`);
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : integerValue(value, field);
}

function validScope(account: number, sessionId: string): boolean {
  return Number.isSafeInteger(account) && account > 0
    && typeof sessionId === 'string' && sessionId.startsWith(`${account}:`) && sessionId.length <= 512;
}

function cursorRecord(row: Record<string, unknown>): PersonaMemoryCursorRecord {
  return {
    account: integerValue(row.account, 'account'),
    sessionId: typeof row.session_id === 'string' ? row.session_id : (() => { throw new Error('数据库字段 session_id 不是文本'); })(),
    organizedUntilMessageTime: nullableInteger(row.organized_until_message_time, 'organized_until_message_time'),
    organizedUntilMessageRowId: nullableInteger(row.organized_until_message_row_id, 'organized_until_message_row_id'),
    openSegmentStart: nullableInteger(row.open_segment_start, 'open_segment_start'),
  };
}

export function createMemoryCursorRepository(database: DatabaseSync): PersonaMemoryCursorRepository {
  const selectCursor = database.prepare(`
    SELECT account, session_id, organized_until_message_time, organized_until_message_row_id, open_segment_start
    FROM memory_cursors WHERE account = ? AND session_id = ?
  `);
  const upsertCursor = database.prepare(`
    INSERT INTO memory_cursors
      (account, session_id, organized_until_message_time, organized_until_message_row_id, open_segment_start)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (account, session_id) DO UPDATE SET
      organized_until_message_time = excluded.organized_until_message_time,
      organized_until_message_row_id = excluded.organized_until_message_row_id,
      open_segment_start = excluded.open_segment_start
  `);
  const selectPendingMessages = database.prepare(`
    SELECT id AS message_row_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time
    FROM messages
    WHERE session_id = ? AND (
      ? IS NULL OR time > ? OR (time = ? AND (? IS NULL OR id > ?))
    )
    ORDER BY time, id
  `);
  const selectCursorSummaries = database.prepare(`
    SELECT c.account, c.session_id, c.organized_until_message_time, c.organized_until_message_row_id, c.open_segment_start,
      COUNT(m.id) AS pending_message_count, MAX(m.time) AS latest_pending_message_time
    FROM memory_cursors c
    LEFT JOIN messages m ON m.session_id = c.session_id
      AND (c.organized_until_message_time IS NULL OR m.time > c.organized_until_message_time
        OR (m.time = c.organized_until_message_time
          AND (c.organized_until_message_row_id IS NULL OR m.id > c.organized_until_message_row_id)))
    WHERE c.account = ?
    GROUP BY c.account, c.session_id, c.organized_until_message_time,
      c.organized_until_message_row_id, c.open_segment_start
    ORDER BY c.session_id
  `);
  const deleteExpiredTails = database.prepare('DELETE FROM persona_memory_tails WHERE account = ? AND created_at < ?');
  const deleteExpiredOrganizedMessages = database.prepare(`
    DELETE FROM messages
    WHERE time < ? AND EXISTS (
      SELECT 1 FROM memory_cursors c
      WHERE c.account = ? AND c.session_id = messages.session_id
        AND c.organized_until_message_time IS NOT NULL
        AND (messages.time < c.organized_until_message_time
          OR (messages.time = c.organized_until_message_time
            AND c.organized_until_message_row_id IS NOT NULL
            AND messages.id <= c.organized_until_message_row_id))
    )
  `);
  const deleteOrganizedTailRefs = database.prepare(`
    DELETE FROM persona_memory_tails
    WHERE account = ? AND EXISTS (
      SELECT 1 FROM messages m JOIN memory_cursors c
        ON c.account = ? AND c.session_id = m.session_id
      WHERE m.session_id = persona_memory_tails.session_id
        AND m.message_id = persona_memory_tails.message_id
        AND c.organized_until_message_time IS NOT NULL
        AND (m.time < c.organized_until_message_time
          OR (m.time = c.organized_until_message_time
            AND c.organized_until_message_row_id IS NOT NULL
            AND m.id <= c.organized_until_message_row_id))
    )
  `);
  const deleteOrganizedTailRefsForSession = database.prepare(`
    DELETE FROM persona_memory_tails
    WHERE account = ? AND session_id = ? AND EXISTS (
      SELECT 1 FROM messages m JOIN memory_cursors c
        ON c.account = ? AND c.session_id = m.session_id
      WHERE m.session_id = persona_memory_tails.session_id
        AND m.message_id = persona_memory_tails.message_id
        AND c.organized_until_message_time IS NOT NULL
        AND (m.time < c.organized_until_message_time
          OR (m.time = c.organized_until_message_time
            AND c.organized_until_message_row_id IS NOT NULL
            AND m.id <= c.organized_until_message_row_id))
    )
  `);
  const deleteOrganizedMessages = database.prepare(`
    DELETE FROM messages
    WHERE EXISTS (
      SELECT 1 FROM memory_cursors c
      WHERE c.account = ? AND c.session_id = messages.session_id
        AND c.organized_until_message_time IS NOT NULL
        AND (messages.time < c.organized_until_message_time
          OR (messages.time = c.organized_until_message_time
            AND c.organized_until_message_row_id IS NOT NULL
            AND messages.id <= c.organized_until_message_row_id))
    )
  `);
  const deleteOrganizedMessagesForSession = database.prepare(`
    DELETE FROM messages
    WHERE session_id = ? AND EXISTS (
      SELECT 1 FROM memory_cursors c
      WHERE c.account = ? AND c.session_id = messages.session_id
        AND c.organized_until_message_time IS NOT NULL
        AND (messages.time < c.organized_until_message_time
          OR (messages.time = c.organized_until_message_time
            AND c.organized_until_message_row_id IS NOT NULL
            AND messages.id <= c.organized_until_message_row_id))
    )
  `);

  function inTransaction<T>(task: () => T): T {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = task();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* 保留原始错误。 */ }
      throw error;
    }
  }

  return {
    personaMemoryCursor(account, sessionId) {
      if (!validScope(account, sessionId)) return undefined;
      const row = selectCursor.get(account, sessionId) as Record<string, unknown> | undefined;
      return row ? cursorRecord(row) : undefined;
    },

    savePersonaMemoryCursor(cursor) {
      if (!validScope(cursor.account, cursor.sessionId)
        || (cursor.organizedUntilMessageTime !== null
          && (!Number.isSafeInteger(cursor.organizedUntilMessageTime) || cursor.organizedUntilMessageTime < 0))
        || ((cursor.organizedUntilMessageRowId ?? null) !== null
          && (!Number.isSafeInteger(cursor.organizedUntilMessageRowId)
            || cursor.organizedUntilMessageRowId! <= 0 || cursor.organizedUntilMessageTime === null))
        || (cursor.openSegmentStart !== null
          && (!Number.isSafeInteger(cursor.openSegmentStart) || cursor.openSegmentStart < 0
            || (cursor.organizedUntilMessageTime !== null && cursor.openSegmentStart <= cursor.organizedUntilMessageTime)))) {
        throw new RangeError('人格记忆游标无效');
      }
      upsertCursor.run(
        cursor.account,
        cursor.sessionId,
        cursor.organizedUntilMessageTime,
        cursor.organizedUntilMessageRowId ?? null,
        cursor.openSegmentStart,
      );
    },

    listPersonaMemoryPendingMessages(account, sessionId) {
      if (!validScope(account, sessionId)) return [];
      const cursor = selectCursor.get(account, sessionId) as Record<string, unknown> | undefined;
      const organizedUntil = cursor ? nullableInteger(cursor.organized_until_message_time, 'organized_until_message_time') : null;
      const organizedUntilRowId = cursor
        ? nullableInteger(cursor.organized_until_message_row_id, 'organized_until_message_row_id')
        : null;
      const rows = selectPendingMessages.all(
        sessionId, organizedUntil, organizedUntil, organizedUntil, organizedUntilRowId, organizedUntilRowId,
      ) as Array<Record<string, unknown>>;
      return rows.map((row) => {
        const isSelf = integerValue(row.is_self, 'is_self');
        if (isSelf !== 0 && isSelf !== 1) throw new Error('数据库字段 is_self 无效');
        if (typeof row.sender_name !== 'string' || typeof row.plain_text !== 'string' || typeof row.message_id !== 'string') {
          throw new Error('数据库消息字段无效');
        }
        if (typeof row.segments_json !== 'string') throw new Error('数据库消息段字段无效');
        const segments: unknown = JSON.parse(row.segments_json);
        if (!Array.isArray(segments)) throw new Error('数据库消息段字段无效');
        return {
          rowId: integerValue(row.message_row_id, 'message_row_id'),
          messageId: row.message_id,
          senderId: integerValue(row.sender_id, 'sender_id'),
          senderName: row.sender_name,
          isSelf: isSelf === 1,
          plainText: row.plain_text,
          segments,
          time: integerValue(row.time, 'time'),
        };
      });
    },

    listPersonaMemoryCursorSummaries(account) {
      if (!Number.isSafeInteger(account) || account <= 0) return [];
      const rows = selectCursorSummaries.all(account) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        ...cursorRecord(row),
        pendingMessageCount: integerValue(row.pending_message_count, 'pending_message_count'),
        latestPendingMessageTime: nullableInteger(row.latest_pending_message_time, 'latest_pending_message_time'),
      }));
    },

    deleteOrganizedPersonaMemoryMessagesBefore(account, cutoff) {
      if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(cutoff) || cutoff < 0) return 0;
      return inTransaction(() => {
        deleteExpiredTails.run(account, cutoff);
        return Number(deleteExpiredOrganizedMessages.run(cutoff, account).changes);
      });
    },

    clearOrganizedPersonaMemoryMessages(account, sessionId) {
      if (!Number.isSafeInteger(account) || account <= 0
        || (sessionId !== undefined && !validScope(account, sessionId))) return 0;
      return inTransaction(() => {
        if (sessionId !== undefined) {
          deleteOrganizedTailRefsForSession.run(account, sessionId, account);
          return Number(deleteOrganizedMessagesForSession.run(sessionId, account).changes);
        }
        deleteOrganizedTailRefs.run(account, account);
        return Number(deleteOrganizedMessages.run(account).changes);
      });
    },
  };
}
