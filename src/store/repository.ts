import type { DatabaseSync } from 'node:sqlite';
import { createPanelQueries } from './panel-queries.ts';
import { createPersonaVersionRepository } from './persona-version-repo.ts';
import { createAffectQueries } from './affect-repo.ts';
import { createPrivacyQueries } from './privacy-repo.ts';
import { createPrivateFactControlsQueries } from './privacy-controls-repo.ts';
import { createPrivateFactMentionQueries } from './privacy-mention-repo.ts';
import { createStickerQueries } from './sticker-repo.ts';
import { createRecentExtractUsageQueries } from './recent-extract-usage-repo.ts';
import { createQqProfileQueries } from './qq-profile-repo.ts';
import type { ImageCaptionKind, StoreRepository } from './repository-types.ts';

export type {
  DebugTraceRecord,
  DecisionRecord,
  ImageCaptionKind,
  ImageCaptionRecord,
  MessageStorageRecord,
  PipelineTraceRecord,
  StoreRepository,
  StoredDebugTrace,
  StoredDecision,
  StoredPipelineTrace,
  UsageAccountSummary,
  UsageRange,
  UsageRangeSummary,
  UsageRecord,
  UsageSlotSummary,
  UsageSummary,
} from './repository-types.ts';

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
  const updateMessageSegments = database.prepare(
    'UPDATE messages SET segments_json = ? WHERE session_id = ? AND message_id = ?',
  );
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
  const selectProfileActivitySessions = database.prepare(`
    SELECT session_id FROM messages WHERE time >= ? AND time <= ?
    UNION
    SELECT session_id FROM tags WHERE origin = 'stats' AND category = 'schedule'
    ORDER BY session_id
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
  const selectImageCaption = database.prepare(`
    SELECT md5, caption, kind, description, text, legible, vision_model, vision_template_version, time
    FROM image_captions WHERE key = ? AND md5 = ?
  `);
  const upsertImageCaption = database.prepare(`
    INSERT INTO image_captions
      (key, caption, time, md5, kind, description, text, legible, vision_model, vision_template_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      caption = excluded.caption,
      time = excluded.time,
      md5 = excluded.md5,
      kind = excluded.kind,
      description = excluded.description,
      text = excluded.text,
      legible = excluded.legible,
      vision_model = excluded.vision_model,
      vision_template_version = excluded.vision_template_version
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
  const selectDecisionsInRange = database.prepare(`
    SELECT id, time, session_id, message_id, replied, reason, detail_json
    FROM decisions
    WHERE session_id = ? AND time >= ? AND time <= ?
    ORDER BY time, id
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
    ...createRecentExtractUsageQueries(database),
    ...createQqProfileQueries(database),
    ...createAffectQueries(database),
    ...createPersonaVersionRepository(database, clock),
    ...createPrivacyQueries(database),
    ...createPrivateFactMentionQueries(database),
    ...createPrivateFactControlsQueries(database),
    ...createStickerQueries(database),
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

    updateMessageSegments(sessionId, messageId, segments) {
      updateMessageSegments.run(JSON.stringify(segments), sessionId, messageId);
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

    profileActivitySessions(fromTime, toTime) {
      if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime < fromTime) {
        throw new RangeError('活动统计时间范围无效');
      }
      const rows = selectProfileActivitySessions.all(fromTime, toTime) as Array<Record<string, unknown>>;
      return rows.map((row) => stringValue(row.session_id, 'session_id'));
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

    getImageCaption(md5) {
      if (!/^[a-f\d]{32}$/iu.test(md5)) throw new TypeError('图片 md5 格式无效');
      const normalized = md5.toLowerCase();
      const row = selectImageCaption.get(normalized, normalized) as Record<string, unknown> | undefined;
      if (!row || !['sticker', 'photo', 'screenshot', 'other'].includes(String(row.kind))
        || typeof row.md5 !== 'string' || typeof row.caption !== 'string'
        || typeof row.description !== 'string' || typeof row.text !== 'string'
        || (row.legible !== 0 && row.legible !== 1)
        || typeof row.vision_model !== 'string' || typeof row.vision_template_version !== 'string') return undefined;
      return {
        md5: row.md5,
        caption: row.caption,
        kind: row.kind as ImageCaptionKind,
        desc: row.description,
        text: row.text,
        legible: row.legible === 1,
        visionModel: row.vision_model,
        visionTemplateVersion: row.vision_template_version,
        time: numberValue(row.time, 'time'),
      };
    },

    setImageCaption(record) {
      if (!/^[a-f\d]{32}$/iu.test(record.md5)) throw new TypeError('图片 md5 格式无效');
      if (!['sticker', 'photo', 'screenshot', 'other'].includes(record.kind)) throw new TypeError('图片类型无效');
      if (typeof record.legible !== 'boolean' || !Number.isFinite(record.time)) throw new TypeError('图片缓存元数据无效');
      const md5 = record.md5.toLowerCase();
      upsertImageCaption.run(
        md5,
        record.caption,
        record.time,
        md5,
        record.kind,
        record.desc,
        record.text,
        record.legible ? 1 : 0,
        record.visionModel,
        record.visionTemplateVersion,
      );
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

    decisionsInRange(sessionId, fromTime, toTime) {
      if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime < fromTime) {
        throw new RangeError('决策时间范围无效');
      }
      const rows = selectDecisionsInRange.all(sessionId, fromTime, toTime) as Array<Record<string, unknown>>;
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
