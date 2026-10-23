import type { DatabaseSync } from 'node:sqlite';

export interface GroupEventInput {
  account: number;
  sourceGroupId: number;
  anchorMessageId: string;
  title: string;
  summary: string;
  participantIds: number[];
  evidenceMessageIds: string[];
  occurredAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface StoredGroupEvent extends GroupEventInput {
  id: number;
}

export interface EventRepository {
  upsertGroupEvent(event: GroupEventInput): number;
  listGroupEvents(account: number, sourceGroupId: number, since: number, limit: number): StoredGroupEvent[];
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validText(value: string, field: string, max: number): string {
  const text = value.trim();
  const length = Array.from(text).length;
  if (length < 1 || length > max) throw new RangeError(`${field} 长度必须为 1–${max} 个字符`);
  return text;
}

function uniqueIds(values: readonly number[], field: string): number[] {
  if (!Array.isArray(values) || values.some((value) => !validId(value))) {
    throw new RangeError(`${field} 必须是正整数列表`);
  }
  return [...new Set(values)].sort((first, second) => first - second);
}

function uniqueMessageIds(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'
    || value.trim().length < 1 || value.length > 512)) {
    throw new RangeError(`${field} 必须是有效消息 ID 列表`);
  }
  return [...new Set(values.map((value) => value.trim()))];
}

function numberValue(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new Error(`数据库字段 ${field} 不是安全整数`);
  }
  return number;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function numberArrayValue(json: string, field: string): number[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((item) => !validId(item))) {
    throw new Error(`数据库字段 ${field} 不是有效 ID 列表`);
  }
  return value;
}

function stringArrayValue(json: string, field: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`数据库字段 ${field} 不是有效文本列表`);
  }
  return value;
}

export function createEventRepository(database: DatabaseSync): EventRepository {
  const upsertEvent = database.prepare(`
    INSERT INTO events (
      account, source_group_id, anchor_message_id, title, summary, participant_ids_json,
      evidence_message_ids_json, occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account, source_group_id, anchor_message_id, title) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      participant_ids_json = excluded.participant_ids_json,
      evidence_message_ids_json = excluded.evidence_message_ids_json,
      occurred_at = excluded.occurred_at,
      updated_at = excluded.updated_at
  `);
  const selectEventId = database.prepare(`
    SELECT id FROM events WHERE account = ? AND source_group_id = ? AND anchor_message_id = ? AND title = ?
  `);
  const selectGroupEvents = database.prepare(`
    SELECT id, account, source_group_id, anchor_message_id, title, summary,
      participant_ids_json, evidence_message_ids_json, occurred_at, created_at, updated_at
    FROM events
    WHERE account = ? AND source_group_id = ? AND occurred_at >= ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `);

  return {
    upsertGroupEvent(event) {
      if (!validId(event.account) || !validId(event.sourceGroupId)) {
        throw new RangeError('群事件账号与来源群必须是正整数');
      }
      if (typeof event.anchorMessageId !== 'string' || event.anchorMessageId.trim().length < 1
        || event.anchorMessageId.length > 512) throw new RangeError('群事件锚点消息 ID 无效');
      if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0
        || !Number.isSafeInteger(event.createdAt) || event.createdAt < 0
        || !Number.isSafeInteger(event.updatedAt) || event.updatedAt < 0) {
        throw new RangeError('群事件时间无效');
      }
      const title = validText(event.title, '事件标题', 16);
      const summary = validText(event.summary, '事件摘要', 60);
      const participantIds = uniqueIds(event.participantIds, '参与者');
      const evidenceMessageIds = uniqueMessageIds(event.evidenceMessageIds, '证据消息');
      const anchorMessageId = event.anchorMessageId.trim();
      if (!evidenceMessageIds.includes(anchorMessageId)) throw new RangeError('群事件锚点必须包含在证据消息中');

      upsertEvent.run(
        event.account,
        event.sourceGroupId,
        anchorMessageId,
        title,
        summary,
        JSON.stringify(participantIds),
        JSON.stringify(evidenceMessageIds),
        event.occurredAt,
        event.createdAt,
        event.updatedAt,
      );
      const row = selectEventId.get(event.account, event.sourceGroupId, anchorMessageId, title) as
        { id: unknown } | undefined;
      if (!row) throw new Error('群事件写入后未能读回');
      return numberValue(row.id, 'id');
    },

    listGroupEvents(account, sourceGroupId, since, limit) {
      if (!validId(account) || !validId(sourceGroupId)) throw new RangeError('群事件查询范围无效');
      if (!Number.isSafeInteger(since) || since < 0) throw new RangeError('群事件查询时间无效');
      if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('群事件查询数量无效');
      if (limit === 0) return [];
      const rows = selectGroupEvents.all(account, sourceGroupId, since, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: numberValue(row.id, 'id'),
        account: numberValue(row.account, 'account'),
        sourceGroupId: numberValue(row.source_group_id, 'source_group_id'),
        anchorMessageId: stringValue(row.anchor_message_id, 'anchor_message_id'),
        title: stringValue(row.title, 'title'),
        summary: stringValue(row.summary, 'summary'),
        participantIds: numberArrayValue(stringValue(row.participant_ids_json, 'participant_ids_json'), 'participant_ids_json'),
        evidenceMessageIds: stringArrayValue(
          stringValue(row.evidence_message_ids_json, 'evidence_message_ids_json'),
          'evidence_message_ids_json',
        ),
        occurredAt: numberValue(row.occurred_at, 'occurred_at'),
        createdAt: numberValue(row.created_at, 'created_at'),
        updatedAt: numberValue(row.updated_at, 'updated_at'),
      }));
    },
  };
}
