import type { DatabaseSync } from 'node:sqlite';

export interface InnerVoiceRepository {
  saveInnerVoiceForMessage(sessionId: string, messageId: string, values: readonly string[], time: number): void;
  innerVoiceForMessage(sessionId: string, messageId: string): string[];
}

export function createInnerVoiceRepository(
  database: DatabaseSync,
  transaction: <T>(task: () => T) => T,
): InnerVoiceRepository {
  const deleteForMessage = database.prepare(
    'DELETE FROM inner_voice WHERE session_id = ? AND message_id = ?',
  );
  const insertForMessage = database.prepare(`
    INSERT INTO inner_voice (session_id, message_id, ordinal, text, time)
    VALUES (?, ?, ?, ?, ?)
  `);
  const selectForMessage = database.prepare(`
    SELECT text FROM inner_voice
    WHERE session_id = ? AND message_id = ?
    ORDER BY ordinal
  `);

  return {
    saveInnerVoiceForMessage(sessionId, messageId, values, time) {
      if (!sessionId || !messageId) throw new RangeError('心声消息标识无效');
      if (!Number.isSafeInteger(time) || time < 0) throw new RangeError('心声时间无效');
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
        throw new TypeError('心声必须是文本数组');
      }
      const entries = values.filter((value) => value.length > 0);
      transaction(() => {
        deleteForMessage.run(sessionId, messageId);
        entries.forEach((text, ordinal) => insertForMessage.run(sessionId, messageId, ordinal, text, time));
      });
    },
    innerVoiceForMessage(sessionId, messageId) {
      const rows = selectForMessage.all(sessionId, messageId) as Array<Record<string, unknown>>;
      return rows.map((row) => {
        if (typeof row.text !== 'string') throw new Error('数据库字段 inner_voice.text 不是文本');
        return row.text;
      });
    },
  };
}
