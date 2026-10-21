import type { DatabaseSync } from 'node:sqlite';
import { isTagCategory, type TagCategory } from '../core/impressions/tag-model.ts';

export type TagDropReason = 'schedule_by_stats';

export interface TagDropRecord {
  id: number;
  account: number;
  sessionId: string;
  userId: number | null;
  category: TagCategory;
  text: string;
  reason: TagDropReason;
  time: number;
}

export type TagDropWrite = Omit<TagDropRecord, 'id'>;

export interface TagDropRepository {
  recordTagDrop(input: TagDropWrite): void;
  latestScheduleDrop(account: number, sessionId: string, userId: number | null, since: number): TagDropRecord | undefined;
  deleteTagDropsForSession(account: number, sessionId: string): number;
}

const RETAIN_MS = 7 * 24 * 60 * 60 * 1_000;

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && Number.isSafeInteger(Number(value))) return Number(value);
  throw new Error(`数据库字段 ${field} 不是安全整数`);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function parseTagDrop(row: Record<string, unknown>): TagDropRecord {
  const userId = row.user_id === null ? null : numberValue(row.user_id, 'user_id');
  if (row.reason !== 'schedule_by_stats') throw new Error('数据库字段 reason 无效');
  if (typeof row.category !== 'string' || !isTagCategory(row.category)) throw new Error('数据库字段 category 无效');
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    sessionId: stringValue(row.session_id, 'session_id'),
    userId,
    category: row.category,
    text: stringValue(row.text, 'text'),
    reason: row.reason,
    time: numberValue(row.time, 'time'),
  };
}

export function createTagDropRepository(database: DatabaseSync): TagDropRepository {
  const pruneExpired = database.prepare('DELETE FROM tag_drop_events WHERE time < ?');
  const insert = database.prepare(`
    INSERT INTO tag_drop_events (account, session_id, user_id, category, text, reason, time)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectLatest = database.prepare(`
    SELECT id, account, session_id, user_id, category, text, reason, time
    FROM tag_drop_events
    WHERE account = ? AND session_id = ? AND user_id IS ? AND reason = ? AND time >= ?
    ORDER BY time DESC, id DESC
    LIMIT 1
  `);
  const deleteSession = database.prepare('DELETE FROM tag_drop_events WHERE account = ? AND session_id = ?');

  return {
    recordTagDrop(input) {
      if (!Number.isSafeInteger(input.account) || input.account <= 0
        || typeof input.sessionId !== 'string' || !input.sessionId.startsWith(`${input.account}:group:`)
        || (input.userId !== null && (!Number.isSafeInteger(input.userId) || input.userId <= 0))
        || !isTagCategory(input.category)
        || typeof input.text !== 'string' || !input.text.trim() || Array.from(input.text).length > 120
        || input.reason !== 'schedule_by_stats'
        || !Number.isSafeInteger(input.time) || input.time < 0) {
        throw new RangeError('画像丢弃记录无效');
      }
      pruneExpired.run(input.time - RETAIN_MS);
      insert.run(input.account, input.sessionId, input.userId, input.category, input.text, input.reason, input.time);
    },
    latestScheduleDrop(account, sessionId, userId, since) {
      if (!Number.isSafeInteger(account) || account <= 0
        || typeof sessionId !== 'string' || !sessionId.startsWith(`${account}:group:`)
        || (userId !== null && (!Number.isSafeInteger(userId) || userId <= 0))
        || !Number.isSafeInteger(since) || since < 0) return undefined;
      const row = selectLatest.get(account, sessionId, userId, 'schedule_by_stats', since) as Record<string, unknown> | undefined;
      return row ? parseTagDrop(row) : undefined;
    },
    deleteTagDropsForSession(account, sessionId) {
      if (!Number.isSafeInteger(account) || account <= 0
        || typeof sessionId !== 'string' || !sessionId.startsWith(`${account}:group:`)) return 0;
      return Number(deleteSession.run(account, sessionId).changes);
    },
  };
}
