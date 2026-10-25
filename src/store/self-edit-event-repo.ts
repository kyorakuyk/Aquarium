import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export interface SelfEditEventChange {
  key: string;
  before: unknown;
  after: unknown;
}

export interface SelfEditEventInput {
  account: number;
  ownerId: number;
  sessionId: string;
  personaId?: string;
  time: number;
  messageId: string;
  summary: string;
  changes: SelfEditEventChange[];
}

export interface StoredSelfEditEvent extends SelfEditEventInput {
  id: number;
}

export interface SelfEditEventRepository {
  recordSelfEditEvent(input: SelfEditEventInput): number;
  recentSelfEditEvents(account: number, count: number): StoredSelfEditEvent[];
  latestSelfEditEvent(account: number, sessionId: string): StoredSelfEditEvent | undefined;
}

const eventChangeSchema = z.object({
  key: z.string().min(1).max(100),
  before: z.unknown(),
  after: z.unknown(),
}).strict();
const eventChangesSchema = z.array(eventChangeSchema).min(1).max(8);

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function storedEvent(row: Record<string, unknown>): StoredSelfEditEvent {
  const rawChanges = row.changes_json;
  if (typeof rawChanges !== 'string') throw new TypeError('设置修改事件 changes_json 必须是文本');
  let parsed: unknown;
  try { parsed = JSON.parse(rawChanges) as unknown; }
  catch { throw new TypeError('设置修改事件 changes_json 不是合法 JSON'); }
  const changes = eventChangesSchema.parse(parsed);
  const result: StoredSelfEditEvent = {
    id: Number(row.id),
    account: Number(row.account),
    ownerId: Number(row.owner_id),
    sessionId: String(row.session_id),
    ...(row.persona_id === null ? {} : { personaId: String(row.persona_id) }),
    time: Number(row.time),
    messageId: String(row.message_id),
    summary: String(row.summary),
    changes,
  };
  if (!positiveId(result.id) || !positiveId(result.account) || !positiveId(result.ownerId)
    || !Number.isSafeInteger(result.time) || result.time < 0) {
    throw new TypeError('设置修改事件数据库行无效');
  }
  return result;
}

export function createSelfEditEventRepository(database: DatabaseSync): SelfEditEventRepository {
  const insert = database.prepare(`
    INSERT INTO self_edit_events
      (account, owner_id, session_id, persona_id, time, message_id, summary, changes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectById = database.prepare(`
    SELECT id, account, owner_id, session_id, persona_id, time, message_id, summary, changes_json
    FROM self_edit_events WHERE id = ?
  `);
  const selectRecent = database.prepare(`
    SELECT id, account, owner_id, session_id, persona_id, time, message_id, summary, changes_json
    FROM self_edit_events WHERE account = ?
    ORDER BY time DESC, id DESC LIMIT ?
  `);
  const selectLatestForSession = database.prepare(`
    SELECT id, account, owner_id, session_id, persona_id, time, message_id, summary, changes_json
    FROM self_edit_events WHERE account = ? AND session_id = ?
    ORDER BY time DESC, id DESC LIMIT 1
  `);

  return {
    recordSelfEditEvent(input) {
      const changesJson = JSON.stringify(eventChangesSchema.parse(input.changes));
      if (!positiveId(input.account) || !positiveId(input.ownerId)
        || !Number.isSafeInteger(input.time) || input.time < 0
        || input.sessionId.trim().length < 1 || input.sessionId.length > 512
        || input.messageId.trim().length < 1 || input.messageId.length > 512
        || (input.personaId !== undefined && (input.personaId.trim().length < 1 || input.personaId.length > 40))
        || input.summary.trim().length < 1 || input.summary.length > 1_000
        || changesJson.length > 16_384) {
        throw new TypeError('设置修改事件数据无效');
      }
      const result = insert.run(
        input.account,
        input.ownerId,
        input.sessionId,
        input.personaId ?? null,
        input.time,
        input.messageId,
        input.summary.trim(),
        changesJson,
      );
      const id = Number(result.lastInsertRowid);
      const row = selectById.get(id) as Record<string, unknown> | undefined;
      if (!row) throw new Error('设置修改事件写入后未能读回');
      return storedEvent(row).id;
    },
    recentSelfEditEvents(account, count) {
      if (!positiveId(account) || !Number.isSafeInteger(count) || count < 0 || count > 200) {
        throw new RangeError('设置修改事件查询范围无效');
      }
      if (count === 0) return [];
      return (selectRecent.all(account, count) as Array<Record<string, unknown>>).map(storedEvent);
    },
    latestSelfEditEvent(account, sessionId) {
      if (!positiveId(account) || sessionId.trim().length < 1 || sessionId.length > 512) {
        throw new RangeError('设置修改事件查询范围无效');
      }
      const row = selectLatestForSession.get(account, sessionId) as Record<string, unknown> | undefined;
      return row ? storedEvent(row) : undefined;
    },
  };
}
