import type { DatabaseSync } from 'node:sqlite';

export interface PersonaMemoryCursorRecord {
  account: number;
  sessionId: string;
  organizedUntilMessageTime: number | null;
  openSegmentStart: number | null;
}

export interface PersonaMemoryCursorSummary extends PersonaMemoryCursorRecord {
  pendingMessageCount: number;
  latestPendingMessageTime: number | null;
}

export interface PersonaMemoryCursorMessage {
  messageId: string;
  senderId: number;
  senderName: string;
  isSelf: boolean;
  plainText: string;
  time: number;
}

export interface PersonaMemoryCursorRepository {
  personaMemoryCursor(account: number, sessionId: string): PersonaMemoryCursorRecord | undefined;
  savePersonaMemoryCursor(cursor: PersonaMemoryCursorRecord): void;
  listPersonaMemoryPendingMessages(account: number, sessionId: string): PersonaMemoryCursorMessage[];
  listPersonaMemoryCursorSummaries(account: number): PersonaMemoryCursorSummary[];
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
    openSegmentStart: nullableInteger(row.open_segment_start, 'open_segment_start'),
  };
}

export function createMemoryCursorRepository(database: DatabaseSync): PersonaMemoryCursorRepository {
  const selectCursor = database.prepare(`
    SELECT account, session_id, organized_until_message_time, open_segment_start
    FROM memory_cursors WHERE account = ? AND session_id = ?
  `);
  const upsertCursor = database.prepare(`
    INSERT INTO memory_cursors (account, session_id, organized_until_message_time, open_segment_start)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (account, session_id) DO UPDATE SET
      organized_until_message_time = excluded.organized_until_message_time,
      open_segment_start = excluded.open_segment_start
  `);
  const selectPendingMessages = database.prepare(`
    SELECT message_id, sender_id, sender_name, is_self, plain_text, time
    FROM messages
    WHERE session_id = ? AND (? IS NULL OR time > ?)
    ORDER BY time, id
  `);
  const selectCursorSummaries = database.prepare(`
    SELECT c.account, c.session_id, c.organized_until_message_time, c.open_segment_start,
      COUNT(m.id) AS pending_message_count, MAX(m.time) AS latest_pending_message_time
    FROM memory_cursors c
    LEFT JOIN messages m ON m.session_id = c.session_id
      AND (c.organized_until_message_time IS NULL OR m.time > c.organized_until_message_time)
    WHERE c.account = ?
    GROUP BY c.account, c.session_id, c.organized_until_message_time, c.open_segment_start
    ORDER BY c.session_id
  `);

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
        || (cursor.openSegmentStart !== null
          && (!Number.isSafeInteger(cursor.openSegmentStart) || cursor.openSegmentStart < 0
            || (cursor.organizedUntilMessageTime !== null && cursor.openSegmentStart <= cursor.organizedUntilMessageTime)))) {
        throw new RangeError('人格记忆游标无效');
      }
      upsertCursor.run(cursor.account, cursor.sessionId, cursor.organizedUntilMessageTime, cursor.openSegmentStart);
    },

    listPersonaMemoryPendingMessages(account, sessionId) {
      if (!validScope(account, sessionId)) return [];
      const cursor = selectCursor.get(account, sessionId) as Record<string, unknown> | undefined;
      const organizedUntil = cursor ? nullableInteger(cursor.organized_until_message_time, 'organized_until_message_time') : null;
      const rows = selectPendingMessages.all(sessionId, organizedUntil, organizedUntil) as Array<Record<string, unknown>>;
      return rows.map((row) => {
        const isSelf = integerValue(row.is_self, 'is_self');
        if (isSelf !== 0 && isSelf !== 1) throw new Error('数据库字段 is_self 无效');
        if (typeof row.sender_name !== 'string' || typeof row.plain_text !== 'string' || typeof row.message_id !== 'string') {
          throw new Error('数据库消息字段无效');
        }
        return {
          messageId: row.message_id,
          senderId: integerValue(row.sender_id, 'sender_id'),
          senderName: row.sender_name,
          isSelf: isSelf === 1,
          plainText: row.plain_text,
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
  };
}
