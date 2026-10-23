import type { DatabaseSync } from 'node:sqlite';
import { createEventAdvocacyRepository, type EventAdvocacyRepository } from './event-advocacy-repo.ts';

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

export type EventNoteIntent = 'confide' | 'clarify' | 'advocate';
export type EventNoteLevel = 'L0' | 'L1' | 'L2';
export type EventNoteStatus = 'active' | 'retracted';

export interface GroupEventNoteInput {
  account: number;
  eventId: number;
  ownerId: number;
  sourceSessionId: string;
  text: string;
  intent: EventNoteIntent;
  level: EventNoteLevel;
  status: EventNoteStatus;
  sourceMessageIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StoredGroupEventNote extends GroupEventNoteInput {
  id: number;
}

export type GroupEventNoteUpdate = Pick<
  GroupEventNoteInput,
  'sourceSessionId' | 'text' | 'intent' | 'level' | 'status' | 'sourceMessageIds' | 'updatedAt'
>;

export interface EventRepository extends EventAdvocacyRepository {
  upsertGroupEvent(event: GroupEventInput): number;
  getGroupEvent(account: number, id: number): StoredGroupEvent | undefined;
  listGroupEvents(account: number, sourceGroupId: number, since: number, limit: number): StoredGroupEvent[];
  listRecentGroupEventGroupIds(account: number, since: number): number[];
  upsertGroupEventNote(note: GroupEventNoteInput): number;
  listGroupEventNotesForOwner(account: number, ownerId: number): StoredGroupEventNote[];
  listGroupEventNotesForEvent(account: number, eventId: number, status?: EventNoteStatus): StoredGroupEventNote[];
  updateGroupEventNote(account: number, id: number, update: GroupEventNoteUpdate): StoredGroupEventNote | undefined;
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
  const selectGroupEventById = database.prepare(`
    SELECT id, account, source_group_id, anchor_message_id, title, summary,
      participant_ids_json, evidence_message_ids_json, occurred_at, created_at, updated_at
    FROM events WHERE account = ? AND id = ?
  `);
  const selectRecentGroupEventGroupIds = database.prepare(`
    SELECT DISTINCT source_group_id
    FROM events
    WHERE account = ? AND occurred_at >= ?
    ORDER BY source_group_id
  `);
  const upsertEventNote = database.prepare(`
    INSERT INTO event_notes (
      account, event_id, owner_id, source_session_id, text, intent, level, status,
      source_message_ids_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (event_id, owner_id) DO UPDATE SET
      source_session_id = excluded.source_session_id,
      text = excluded.text,
      intent = excluded.intent,
      level = excluded.level,
      status = excluded.status,
      source_message_ids_json = excluded.source_message_ids_json,
      updated_at = excluded.updated_at
  `);
  const selectEventNoteId = database.prepare(
    'SELECT id FROM event_notes WHERE account = ? AND event_id = ? AND owner_id = ?',
  );
  const selectOwnerEventNotes = database.prepare(`
    SELECT id, account, event_id, owner_id, source_session_id, text, intent, level, status,
      source_message_ids_json, created_at, updated_at
    FROM event_notes WHERE account = ? AND owner_id = ?
    ORDER BY updated_at DESC, id DESC
  `);
  const selectEventNotes = database.prepare(`
    SELECT id, account, event_id, owner_id, source_session_id, text, intent, level, status,
      source_message_ids_json, created_at, updated_at
    FROM event_notes WHERE account = ? AND event_id = ?
    ORDER BY updated_at DESC, id DESC
  `);
  const selectEventNotesByStatus = database.prepare(`
    SELECT id, account, event_id, owner_id, source_session_id, text, intent, level, status,
      source_message_ids_json, created_at, updated_at
    FROM event_notes WHERE account = ? AND event_id = ? AND status = ?
    ORDER BY updated_at DESC, id DESC
  `);
  const updateEventNote = database.prepare(`
    UPDATE event_notes SET source_session_id = ?, text = ?, intent = ?, level = ?, status = ?,
      source_message_ids_json = ?, updated_at = ?
    WHERE account = ? AND id = ?
  `);
  const selectEventNoteById = database.prepare(`
    SELECT id, account, event_id, owner_id, source_session_id, text, intent, level, status,
      source_message_ids_json, created_at, updated_at
    FROM event_notes WHERE account = ? AND id = ?
  `);

  function mapEventNote(row: Record<string, unknown>): StoredGroupEventNote {
    const intent = stringValue(row.intent, 'intent');
    const level = stringValue(row.level, 'level');
    const status = stringValue(row.status, 'status');
    if (!['confide', 'clarify', 'advocate'].includes(intent)
      || !['L0', 'L1', 'L2'].includes(level)
      || !['active', 'retracted'].includes(status)) {
      throw new Error('数据库字段 event note 枚举值无效');
    }
    return {
      id: numberValue(row.id, 'id'),
      account: numberValue(row.account, 'account'),
      eventId: numberValue(row.event_id, 'event_id'),
      ownerId: numberValue(row.owner_id, 'owner_id'),
      sourceSessionId: stringValue(row.source_session_id, 'source_session_id'),
      text: stringValue(row.text, 'text'),
      intent: intent as EventNoteIntent,
      level: level as EventNoteLevel,
      status: status as EventNoteStatus,
      sourceMessageIds: stringArrayValue(
        stringValue(row.source_message_ids_json, 'source_message_ids_json'),
        'source_message_ids_json',
      ),
      createdAt: numberValue(row.created_at, 'created_at'),
      updatedAt: numberValue(row.updated_at, 'updated_at'),
    };
  }

  return {
    ...createEventAdvocacyRepository(database),
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

    getGroupEvent(account, id) {
      if (!validId(account) || !validId(id)) throw new RangeError('群事件查询范围无效');
      const row = selectGroupEventById.get(account, id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        id: numberValue(row.id, 'id'),
        account: numberValue(row.account, 'account'),
        sourceGroupId: numberValue(row.source_group_id, 'source_group_id'),
        anchorMessageId: stringValue(row.anchor_message_id, 'anchor_message_id'),
        title: stringValue(row.title, 'title'),
        summary: stringValue(row.summary, 'summary'),
        participantIds: numberArrayValue(
          stringValue(row.participant_ids_json, 'participant_ids_json'),
          'participant_ids_json',
        ),
        evidenceMessageIds: stringArrayValue(
          stringValue(row.evidence_message_ids_json, 'evidence_message_ids_json'),
          'evidence_message_ids_json',
        ),
        occurredAt: numberValue(row.occurred_at, 'occurred_at'),
        createdAt: numberValue(row.created_at, 'created_at'),
        updatedAt: numberValue(row.updated_at, 'updated_at'),
      };
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

    listRecentGroupEventGroupIds(account, since) {
      if (!validId(account)) throw new RangeError('群事件查询账号无效');
      if (!Number.isSafeInteger(since) || since < 0) throw new RangeError('群事件查询时间无效');
      const rows = selectRecentGroupEventGroupIds.all(account, since) as Array<Record<string, unknown>>;
      return rows.map((row) => numberValue(row.source_group_id, 'source_group_id'));
    },

    upsertGroupEventNote(note) {
      if (!validId(note.account) || !validId(note.eventId) || !validId(note.ownerId)) {
        throw new RangeError('事件注解账号、事件与主人必须是正整数');
      }
      if (typeof note.sourceSessionId !== 'string' || note.sourceSessionId.trim().length < 1
        || note.sourceSessionId.length > 512) throw new RangeError('事件注解来源会话无效');
      const text = validText(note.text, '事件注解', 4_000);
      if (!['confide', 'clarify', 'advocate'].includes(note.intent)
        || !['L0', 'L1', 'L2'].includes(note.level)
        || !['active', 'retracted'].includes(note.status)) throw new RangeError('事件注解状态无效');
      const sourceMessageIds = uniqueMessageIds(note.sourceMessageIds, '事件注解来源消息');
      if (sourceMessageIds.length === 0) throw new RangeError('事件注解至少需要一条来源消息');
      if (![note.createdAt, note.updatedAt].every((time) => Number.isSafeInteger(time) && time >= 0)) {
        throw new RangeError('事件注解时间无效');
      }
      upsertEventNote.run(
        note.account,
        note.eventId,
        note.ownerId,
        note.sourceSessionId.trim(),
        text,
        note.intent,
        note.level,
        note.status,
        JSON.stringify(sourceMessageIds),
        note.createdAt,
        note.updatedAt,
      );
      const row = selectEventNoteId.get(note.account, note.eventId, note.ownerId) as
        { id: unknown } | undefined;
      if (!row) throw new Error('事件注解写入后未能读回');
      return numberValue(row.id, 'id');
    },

    listGroupEventNotesForOwner(account, ownerId) {
      if (!validId(account) || !validId(ownerId)) throw new RangeError('事件注解主人查询范围无效');
      const rows = selectOwnerEventNotes.all(account, ownerId) as Array<Record<string, unknown>>;
      return rows.map(mapEventNote);
    },

    listGroupEventNotesForEvent(account, eventId, status) {
      if (!validId(account) || !validId(eventId)) throw new RangeError('事件注解事件查询范围无效');
      if (status !== undefined && !['active', 'retracted'].includes(status)) {
        throw new RangeError('事件注解状态无效');
      }
      const rows = (status === undefined
        ? selectEventNotes.all(account, eventId)
        : selectEventNotesByStatus.all(account, eventId, status)) as Array<Record<string, unknown>>;
      return rows.map(mapEventNote);
    },

    updateGroupEventNote(account, id, update) {
      if (!validId(account) || !validId(id)) throw new RangeError('事件注解更新范围无效');
      if (typeof update.sourceSessionId !== 'string' || update.sourceSessionId.trim().length < 1
        || update.sourceSessionId.length > 512) throw new RangeError('事件注解来源会话无效');
      const text = validText(update.text, '事件注解', 4_000);
      if (!['confide', 'clarify', 'advocate'].includes(update.intent)
        || !['L0', 'L1', 'L2'].includes(update.level)
        || !['active', 'retracted'].includes(update.status)) throw new RangeError('事件注解状态无效');
      const sourceMessageIds = uniqueMessageIds(update.sourceMessageIds, '事件注解来源消息');
      if (sourceMessageIds.length === 0 || !Number.isSafeInteger(update.updatedAt) || update.updatedAt < 0) {
        throw new RangeError('事件注解更新数据无效');
      }
      updateEventNote.run(
        update.sourceSessionId.trim(),
        text,
        update.intent,
        update.level,
        update.status,
        JSON.stringify(sourceMessageIds),
        update.updatedAt,
        account,
        id,
      );
      const row = selectEventNoteById.get(account, id) as Record<string, unknown> | undefined;
      return row ? mapEventNote(row) : undefined;
    },
  };
}
