import type { DatabaseSync } from 'node:sqlite';
import type { StoreRepository } from './repository.ts';

export type PanelRepositoryQueries = Pick<StoreRepository,
  'latestSelfMessageForAccount' | 'selfMessagesById' | 'replyCountToday' | 'replyCountTodayForAccount' | 'usageToday' | 'decisionMessageText' | 'decisionById' | 'hasDebugTrace'
>;

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`数据库字段 ${field} 不是数字`);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function messageRecord(row: Record<string, unknown>) {
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
}

export function createPanelQueries(
  database: DatabaseSync,
  clock: () => Date,
): PanelRepositoryQueries {
  const selectSelfMessagesById = database.prepare(`
    SELECT session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time
    FROM messages
    WHERE message_id = ? AND is_self = 1
    ORDER BY time DESC, id DESC
  `);
  const selectLatestSelfMessageForAccount = database.prepare(`
    SELECT session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time
    FROM messages
    WHERE is_self = 1 AND session_id LIKE ?
    ORDER BY time DESC, id DESC
    LIMIT 1
  `);
  const selectTodayUsage = database.prepare(`
    SELECT COUNT(*) AS request_count,
      COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS successful_requests,
      COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed_requests,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cost_cny), 0) AS cost_cny,
      COALESCE(AVG(latency_ms), 0) AS average_latency_ms
    FROM usage
    WHERE time >= ? AND time < ?
  `);
  const selectTodayReplyCount = database.prepare(`
    SELECT COUNT(*) AS total
    FROM decisions
    WHERE replied = 1 AND time >= ? AND time < ?
  `);
  const selectTodayReplyCountForAccount = database.prepare(`
    SELECT COUNT(*) AS total
    FROM decisions
    WHERE replied = 1 AND session_id LIKE ? AND time >= ? AND time < ?
  `);
  const selectDecisionById = database.prepare(`
    SELECT id, time, session_id, message_id, replied, reason, detail_json
    FROM decisions
    WHERE id = ?
  `);
  const selectDecisionMessageText = database.prepare(`
    SELECT plain_text
    FROM messages
    WHERE session_id = ? AND message_id = ?
    LIMIT 1
  `);
  const selectHasDebugTrace = database.prepare(
    'SELECT 1 AS found FROM debug_traces WHERE session_id = ? AND message_id = ? LIMIT 1',
  );

  const todayRange = (): [number, number] => {
    const current = clock();
    return [
      new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime(),
      new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime(),
    ];
  };

  return {
    latestSelfMessageForAccount(account) {
      if (!Number.isSafeInteger(account) || account <= 0) return undefined;
      const row = selectLatestSelfMessageForAccount.get(`${account}:%`) as Record<string, unknown> | undefined;
      return row ? messageRecord(row) : undefined;
    },

    selfMessagesById(messageId) {
      const rows = selectSelfMessagesById.all(messageId) as Array<Record<string, unknown>>;
      return rows.map(messageRecord);
    },

    replyCountToday() {
      const row = selectTodayReplyCount.get(...todayRange()) as Record<string, unknown> | undefined;
      return numberValue(row?.total ?? 0, 'total');
    },

    replyCountTodayForAccount(account) {
      if (!Number.isSafeInteger(account) || account <= 0) return 0;
      const row = selectTodayReplyCountForAccount.get(`${account}:%`, ...todayRange()) as Record<string, unknown> | undefined;
      return numberValue(row?.total ?? 0, 'total');
    },

    usageToday() {
      const row = selectTodayUsage.get(...todayRange()) as Record<string, unknown> | undefined;
      return {
        requestCount: numberValue(row?.request_count ?? 0, 'request_count'),
        successfulRequests: numberValue(row?.successful_requests ?? 0, 'successful_requests'),
        failedRequests: numberValue(row?.failed_requests ?? 0, 'failed_requests'),
        inputTokens: numberValue(row?.input_tokens ?? 0, 'input_tokens'),
        cachedTokens: numberValue(row?.cached_tokens ?? 0, 'cached_tokens'),
        outputTokens: numberValue(row?.output_tokens ?? 0, 'output_tokens'),
        costCny: numberValue(row?.cost_cny ?? 0, 'cost_cny'),
        averageLatencyMs: numberValue(row?.average_latency_ms ?? 0, 'average_latency_ms'),
      };
    },

    decisionMessageText(sessionId, messageId) {
      const row = selectDecisionMessageText.get(sessionId, messageId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return Array.from(stringValue(row.plain_text, 'plain_text')).slice(0, 60).join('');
    },

    decisionById(id) {
      if (!Number.isSafeInteger(id) || id <= 0) return undefined;
      const row = selectDecisionById.get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        id: numberValue(row.id, 'id'),
        time: numberValue(row.time, 'time'),
        sessionId: stringValue(row.session_id, 'session_id'),
        messageId: stringValue(row.message_id, 'message_id'),
        replied: numberValue(row.replied, 'replied') === 1,
        reason: stringValue(row.reason, 'reason'),
        detail: JSON.parse(stringValue(row.detail_json, 'detail_json')) as unknown,
      };
    },

    hasDebugTrace(sessionId, messageId) {
      return selectHasDebugTrace.get(sessionId, messageId) !== undefined;
    },
  };
}
