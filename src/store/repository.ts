import type { DatabaseSync } from 'node:sqlite';

export interface MessageStorageRecord {
  sessionId: string;
  messageId: string;
  senderId: number;
  senderName: string;
  isSelf: boolean;
  plainText: string;
  segments: unknown[];
  time: number;
}

export interface UsageRecord {
  time: number;
  slot: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costCny: number;
  latencyMs: number;
  ok: boolean;
}

export interface DecisionRecord {
  time: number;
  sessionId: string;
  messageId: string;
  replied: boolean;
  reason: string;
  detail: unknown;
}

export interface StoredDecision extends DecisionRecord {
  id: number;
}

export interface StoreRepository {
  saveMessage(message: MessageStorageRecord): boolean;
  recentMessages(sessionId: string, count: number): MessageStorageRecord[];
  lastSelfMessage(sessionId: string): MessageStorageRecord | undefined;
  recordUsage(usage: UsageRecord): void;
  costToday(): number;
  getCaption(key: string): string | undefined;
  setCaption(key: string, caption: string, time?: number): void;
  recordDecision(decision: DecisionRecord): void;
  recentDecisions(count: number): StoredDecision[];
}

function limitValue(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('查询数量必须是非负安全整数');
  }
  return count;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`数据库字段 ${field} 不是数字`);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

export function createRepository(
  database: DatabaseSync,
  clock: () => Date = () => new Date(),
): StoreRepository {
  const insertMessage = database.prepare(`
    INSERT OR IGNORE INTO messages
      (session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRecentMessages = database.prepare(`
    SELECT session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time
    FROM messages
    WHERE session_id = ?
    ORDER BY time DESC, id DESC
    LIMIT ?
  `);
  const selectLastSelfMessage = database.prepare(`
    SELECT session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time
    FROM messages
    WHERE session_id = ? AND is_self = 1
    ORDER BY time DESC, id DESC
    LIMIT 1
  `);
  const insertUsage = database.prepare(`
    INSERT INTO usage
      (time, slot, provider, model, input_tokens, cached_tokens, output_tokens, cost_cny, latency_ms, ok)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectTodayCost = database.prepare(`
    SELECT COALESCE(SUM(cost_cny), 0) AS total
    FROM usage
    WHERE time >= ? AND time < ?
  `);
  const selectCaption = database.prepare('SELECT caption FROM image_captions WHERE key = ?');
  const upsertCaption = database.prepare(`
    INSERT INTO image_captions (key, caption, time)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET caption = excluded.caption, time = excluded.time
  `);
  const insertDecision = database.prepare(`
    INSERT INTO decisions (time, session_id, message_id, replied, reason, detail_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectRecentDecisions = database.prepare(`
    SELECT id, time, session_id, message_id, replied, reason, detail_json
    FROM decisions
    ORDER BY time DESC, id DESC
    LIMIT ?
  `);

  return {
    saveMessage(message) {
      const result = insertMessage.run(
        message.sessionId,
        message.messageId,
        message.senderId,
        message.senderName,
        message.isSelf ? 1 : 0,
        message.plainText,
        JSON.stringify(message.segments),
        message.time,
      );
      return result.changes === 1 || result.changes === 1n;
    },

    recentMessages(sessionId, count) {
      const limit = limitValue(count);
      if (limit === 0) return [];
      const rows = selectRecentMessages.all(sessionId, limit) as Array<Record<string, unknown>>;
      return rows.reverse().map((row) => ({
        sessionId: stringValue(row.session_id, 'session_id'),
        messageId: stringValue(row.message_id, 'message_id'),
        senderId: numberValue(row.sender_id, 'sender_id'),
        senderName: stringValue(row.sender_name, 'sender_name'),
        isSelf: numberValue(row.is_self, 'is_self') === 1,
        plainText: stringValue(row.plain_text, 'plain_text'),
        segments: JSON.parse(stringValue(row.segments_json, 'segments_json')) as unknown[],
        time: numberValue(row.time, 'time'),
      }));
    },

    lastSelfMessage(sessionId) {
      const row = selectLastSelfMessage.get(sessionId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        sessionId: stringValue(row.session_id, 'session_id'),
        messageId: stringValue(row.message_id, 'message_id'),
        senderId: numberValue(row.sender_id, 'sender_id'),
        senderName: stringValue(row.sender_name, 'sender_name'),
        isSelf: numberValue(row.is_self, 'is_self') === 1,
        plainText: stringValue(row.plain_text, 'plain_text'),
        segments: JSON.parse(stringValue(row.segments_json, 'segments_json')) as unknown[],
        time: numberValue(row.time, 'time'),
      };
    },

    recordUsage(usage) {
      insertUsage.run(
        usage.time,
        usage.slot,
        usage.provider,
        usage.model,
        usage.inputTokens,
        usage.cachedTokens,
        usage.outputTokens,
        usage.costCny,
        usage.latencyMs,
        usage.ok ? 1 : 0,
      );
    },

    costToday() {
      const current = clock();
      const start = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
      const end = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime();
      const row = selectTodayCost.get(start, end) as Record<string, unknown> | undefined;
      return numberValue(row?.total ?? 0, 'total');
    },

    getCaption(key) {
      const row = selectCaption.get(key) as Record<string, unknown> | undefined;
      return row ? stringValue(row.caption, 'caption') : undefined;
    },

    setCaption(key, caption, time = clock().getTime()) {
      upsertCaption.run(key, caption, time);
    },

    recordDecision(decision) {
      insertDecision.run(
        decision.time,
        decision.sessionId,
        decision.messageId,
        decision.replied ? 1 : 0,
        decision.reason,
        JSON.stringify(decision.detail) ?? 'null',
      );
    },

    recentDecisions(count) {
      const limit = limitValue(count);
      if (limit === 0) return [];
      const rows = selectRecentDecisions.all(limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: numberValue(row.id, 'id'),
        time: numberValue(row.time, 'time'),
        sessionId: stringValue(row.session_id, 'session_id'),
        messageId: stringValue(row.message_id, 'message_id'),
        replied: numberValue(row.replied, 'replied') === 1,
        reason: stringValue(row.reason, 'reason'),
        detail: JSON.parse(stringValue(row.detail_json, 'detail_json')) as unknown,
      }));
    },
  };
}
