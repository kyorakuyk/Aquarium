import type { DatabaseSync } from 'node:sqlite';
import { createPanelQueries } from './panel-queries.ts';
import { createPersonaVersionRepository, type PersonaVersionRepository } from './persona-version-repo.ts';
import {
  createAffectQueries,
  type AffinityEventRecord,
  type AffinityStateRecord,
  type MoodEventRecord,
  type MoodStateRecord,
  type StoredAffinityEvent,
  type StoredMoodEvent,
  type StoredTag,
  type TagRecord,
  type TagRunRecord,
  type TagUpdate,
} from './affect-repo.ts';

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
  account: number | null;
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

export interface UsageSummary {
  requestCount: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costCny: number;
  averageLatencyMs: number;
}

export type UsageRange = 'today' | '7d' | '30d';

export interface UsageSlotSummary {
  slot: string;
  calls: number;
  costCny: number;
  avgLatencyMs: number;
}

export interface UsageAccountSummary {
  provider: string;
  account: number | null;
  calls: number;
  costCny: number;
  avgLatencyMs: number;
  cacheHitRatio: number | null;
  daily: number[];
  bySlot: UsageSlotSummary[];
}

export interface UsageRangeSummary {
  totals: {
    costCny: number;
    calls: number;
    cacheHitRatio: number | null;
  };
  rows: UsageAccountSummary[];
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

export interface DebugTraceRecord {
  time: number;
  sessionId: string;
  messageId: string;
  slot: string;
  provider: string;
  model: string;
  promptJson: string;
  responseText: string;
  promptHash: string;
  detail: unknown;
}

export interface StoredDebugTrace extends DebugTraceRecord {
  id: number;
}

export interface PipelineTraceRecord {
  time: number;
  sessionId: string;
  messageId: string;
  trace: unknown[];
}

export interface StoredPipelineTrace extends PipelineTraceRecord {
  id: number;
}

export interface StoreRepository extends PersonaVersionRepository {
  saveMessage(message: MessageStorageRecord): boolean;
  recentMessages(sessionId: string, count: number): MessageStorageRecord[];
  messagesInRange(sessionId: string, fromTime: number, toTime: number): MessageStorageRecord[];
  lastMessageTime(sessionId: string): number | null;
  lastMessageBefore(sessionId: string, beforeTime: number): MessageStorageRecord | undefined;
  messageBySessionAndId(sessionId: string, messageId: string): MessageStorageRecord | undefined;
  recentMessagesThrough(sessionId: string, messageId: string, count: number): MessageStorageRecord[];
  lastSelfMessage(sessionId: string): MessageStorageRecord | undefined;
  latestSelfMessageForAccount(account: number): MessageStorageRecord | undefined;
  selfMessagesById(messageId: string): MessageStorageRecord[];
  recordUsage(usage: UsageRecord): void;
  costToday(): number;
  replyCountToday(): number;
  replyCountTodayForAccount(account: number): number;
  replyCountLastHourForAccount(account: number, now: number): number;
  usageToday(): UsageSummary;
  usageByRange(range: UsageRange, now: number): UsageRangeSummary;
  getCaption(key: string): string | undefined;
  setCaption(key: string, caption: string, time?: number): void;
  recordDecision(decision: DecisionRecord): void;
  recentDecisions(count: number): StoredDecision[];
  latestReplyDecision(): StoredDecision | undefined;
  decisionMessageText(sessionId: string, messageId: string): string | undefined;
  decisionById(id: number): StoredDecision | undefined;
  hasDebugTrace(sessionId: string, messageId: string): boolean;
  recordDebugTrace(trace: DebugTraceRecord): void;
  debugTracesFor(sessionId: string, messageId: string): StoredDebugTrace[];
  pruneDebugTraces(now: number, retainDays?: number): number;
  hasPipelineTrace(sessionId: string, messageId: string): boolean;
  recordPipelineTrace(trace: PipelineTraceRecord): void;
  pipelineTraceFor(sessionId: string, messageId: string): StoredPipelineTrace | undefined;
  prunePipelineTraces(now: number, retainDays?: number): number;
  getMoodState(account: number): MoodStateRecord | undefined;
  saveMoodState(state: MoodStateRecord): void;
  recordMoodEvent(event: MoodEventRecord): void;
  recentMoodEvents(account: number, count: number): StoredMoodEvent[];
  moodEventsSince(account: number, since: number): StoredMoodEvent[];
  latestMoodEventAtOrBefore(account: number, time: number): StoredMoodEvent | undefined;
  getAffinityState(account: number, userId: number): AffinityStateRecord | undefined;
  listAffinityStates(account: number): AffinityStateRecord[];
  saveAffinityState(state: AffinityStateRecord): void;
  recordAffinityEvent(event: AffinityEventRecord): void;
  recentAffinityEvents(account: number, userId: number, count: number): StoredAffinityEvent[];
  affinityEventsSince(account: number, userId: number, since: number): StoredAffinityEvent[];
  latestSenderNameForAccount(account: number, userId: number): string | undefined;
  insertTag(tag: TagRecord): number;
  tagById(id: number): StoredTag | undefined;
  listTagsForSubject(account: number, sessionId: string, userId: number | null): StoredTag[];
  listTagsForSession(account: number, sessionId: string): StoredTag[];
  senderNameFor(sessionId: string, senderId: number): string | undefined;
  updateTag(id: number, update: TagUpdate): void;
  getTagRun(account: number, sessionId: string): TagRunRecord | undefined;
  saveTagRun(run: TagRunRecord): void;
  countMessagesAfter(sessionId: string, time: number): number;
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
  const selectMessagesInRange = database.prepare(`
    SELECT session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time
    FROM messages
    WHERE session_id = ? AND time >= ? AND time <= ?
    ORDER BY time, id
  `);
  const selectLastMessageTime = database.prepare(
    'SELECT MAX(time) AS latest_time FROM messages WHERE session_id = ?',
  );
  const selectMessageBySessionAndId = database.prepare(`
    SELECT session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time
    FROM messages
    WHERE session_id = ? AND message_id = ?
    LIMIT 1
  `);
  const selectMessagesThroughMessage = database.prepare(`
    WITH target AS (
      SELECT id FROM messages WHERE session_id = ? AND message_id = ? LIMIT 1
    )
    SELECT m.session_id, m.message_id, m.sender_id, m.sender_name, m.is_self,
      m.plain_text, m.segments_json, m.time
    FROM messages AS m
    CROSS JOIN target
    WHERE m.session_id = ? AND m.id <= target.id
    ORDER BY m.time DESC, m.id DESC
    LIMIT ?
  `);
  const selectLastSelfMessage = database.prepare(`
    SELECT session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time
    FROM messages
    WHERE session_id = ? AND is_self = 1
    ORDER BY time DESC, id DESC
    LIMIT 1
  `);
  const selectLastMessageBefore = database.prepare(`
    SELECT session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time
    FROM messages
    WHERE session_id = ? AND time < ?
    ORDER BY time DESC, id DESC
    LIMIT 1
  `);
  const insertUsage = database.prepare(`
    INSERT INTO usage
      (time, account, slot, provider, model, input_tokens, cached_tokens, output_tokens, cost_cny, latency_ms, ok)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  const insertDebugTrace = database.prepare(`
    INSERT INTO debug_traces
      (time, session_id, message_id, slot, provider, model, prompt_json, response_text, prompt_hash, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectDebugTraces = database.prepare(`
    SELECT id, time, session_id, message_id, slot, provider, model,
      prompt_json, response_text, prompt_hash, detail_json
    FROM debug_traces
    WHERE session_id = ? AND message_id = ?
    ORDER BY time, id
  `);
  const deleteExpiredDebugTraces = database.prepare('DELETE FROM debug_traces WHERE time < ?');
  const insertPipelineTrace = database.prepare(`
    INSERT INTO pipeline_traces (time, session_id, message_id, trace_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, message_id) DO UPDATE SET
      time = excluded.time,
      trace_json = excluded.trace_json
  `);
  const selectPipelineTrace = database.prepare(`
    SELECT id, time, session_id, message_id, trace_json
    FROM pipeline_traces
    WHERE session_id = ? AND message_id = ?
  `);
  const deleteExpiredPipelineTraces = database.prepare('DELETE FROM pipeline_traces WHERE time < ?');

  return {
    ...createPanelQueries(database, clock),
    ...createAffectQueries(database),
    ...createPersonaVersionRepository(database, clock),
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

    messagesInRange(sessionId, fromTime, toTime) {
      if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime < fromTime) {
        throw new RangeError('消息时间范围无效');
      }
      const rows = selectMessagesInRange.all(sessionId, fromTime, toTime) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
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

    lastMessageTime(sessionId) {
      const row = selectLastMessageTime.get(sessionId) as Record<string, unknown> | undefined;
      if (!row || row.latest_time === null) return null;
      return numberValue(row.latest_time, 'latest_time');
    },

    lastMessageBefore(sessionId, beforeTime) {
      if (!Number.isFinite(beforeTime)) throw new RangeError('查询时间必须是有限数字');
      const row = selectLastMessageBefore.get(sessionId, beforeTime) as Record<string, unknown> | undefined;
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

    messageBySessionAndId(sessionId, messageId) {
      const row = selectMessageBySessionAndId.get(sessionId, messageId) as Record<string, unknown> | undefined;
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

    recentMessagesThrough(sessionId, messageId, count) {
      const limit = limitValue(count);
      if (limit === 0) return [];
      const rows = selectMessagesThroughMessage.all(sessionId, messageId, sessionId, limit) as Array<Record<string, unknown>>;
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
        usage.account,
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

    recordDebugTrace(trace) {
      insertDebugTrace.run(
        trace.time,
        trace.sessionId,
        trace.messageId,
        trace.slot,
        trace.provider,
        trace.model,
        trace.promptJson,
        trace.responseText,
        trace.promptHash,
        JSON.stringify(trace.detail) ?? 'null',
      );
    },

    debugTracesFor(sessionId, messageId) {
      const rows = selectDebugTraces.all(sessionId, messageId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: numberValue(row.id, 'id'),
        time: numberValue(row.time, 'time'),
        sessionId: stringValue(row.session_id, 'session_id'),
        messageId: stringValue(row.message_id, 'message_id'),
        slot: stringValue(row.slot, 'slot'),
        provider: stringValue(row.provider, 'provider'),
        model: stringValue(row.model, 'model'),
        promptJson: stringValue(row.prompt_json, 'prompt_json'),
        responseText: stringValue(row.response_text, 'response_text'),
        promptHash: stringValue(row.prompt_hash, 'prompt_hash'),
        detail: JSON.parse(stringValue(row.detail_json, 'detail_json')) as unknown,
      }));
    },

    pruneDebugTraces(now, retainDays = 7) {
      if (!Number.isFinite(now) || !Number.isSafeInteger(retainDays) || retainDays <= 0) {
        throw new RangeError('调试记录清理参数无效');
      }
      const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
      const result = deleteExpiredDebugTraces.run(cutoff);
      return numberValue(result.changes, 'changes');
    },

    recordPipelineTrace(trace) {
      insertPipelineTrace.run(
        trace.time,
        trace.sessionId,
        trace.messageId,
        JSON.stringify(trace.trace),
      );
    },

    pipelineTraceFor(sessionId, messageId) {
      const row = selectPipelineTrace.get(sessionId, messageId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        id: numberValue(row.id, 'id'),
        time: numberValue(row.time, 'time'),
        sessionId: stringValue(row.session_id, 'session_id'),
        messageId: stringValue(row.message_id, 'message_id'),
        trace: JSON.parse(stringValue(row.trace_json, 'trace_json')) as unknown[],
      };
    },

    prunePipelineTraces(now, retainDays = 7) {
      if (!Number.isFinite(now) || !Number.isSafeInteger(retainDays) || retainDays <= 0) {
        throw new RangeError('流水线追踪清理参数无效');
      }
      const cutoff = now - retainDays * 24 * 60 * 60 * 1000;
      const result = deleteExpiredPipelineTraces.run(cutoff);
      return numberValue(result.changes, 'changes');
    },
  };
}
