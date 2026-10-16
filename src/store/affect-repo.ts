import type { DatabaseSync } from 'node:sqlite';
import type { StoreRepository } from './repository.ts';

export type MoodBand = 'low' | 'annoyed' | 'calm' | 'happy' | 'excited';
export type MoodEventSource = 'appraise' | 'rule' | 'band';
export type TagStatus = 'candidate' | 'confirmed' | 'rejected' | 'superseded';
export type TagSource = 'auto' | 'manual';

export interface MoodStateRecord {
  account: number;
  valence: number;
  arousal: number;
  updatedAt: number;
  band: MoodBand;
  bandSince: number;
  lastBandChangeAt: number;
}

export interface MoodEventRecord {
  account: number;
  time: number;
  source: MoodEventSource;
  sessionId: string | null;
  senderId: number | null;
  dv: number;
  da: number;
  appliedDv: number;
  appliedDa: number;
  reason: string;
  bandBefore: MoodBand | null;
  bandAfter: MoodBand | null;
}

export interface StoredMoodEvent extends MoodEventRecord {
  id: number;
}

export interface TagEvidence {
  messageId: string;
  time: number;
  quote: string;
}

export interface TagRecord {
  account: number;
  sessionId: string;
  userId: number | null;
  text: string;
  norm: string;
  status: TagStatus;
  source: TagSource;
  samples: number;
  evidence: TagEvidence[];
  firstSeen: number;
  lastSeen: number;
  supersededBy: number | null;
  updatedAt: number;
}

export interface StoredTag extends TagRecord {
  id: number;
}

export interface TagUpdate {
  text?: string;
  norm?: string;
  status?: TagStatus;
  samples?: number;
  evidence?: TagEvidence[];
  lastSeen?: number;
  supersededBy?: number | null;
  updatedAt?: number;
}

export interface TagRunRecord {
  account: number;
  sessionId: string;
  lastRunAt: number | null;
  lastMessageTime: number | null;
}

export type AffectRepositoryQueries = Pick<StoreRepository,
  'getMoodState' | 'saveMoodState' | 'recordMoodEvent' | 'recentMoodEvents' | 'moodEventsSince'
  | 'insertTag' | 'tagById' | 'listTagsForSubject' | 'updateTag' | 'getTagRun' | 'saveTagRun'
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

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return numberValue(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, field);
}

function moodStateRecord(row: Record<string, unknown>): MoodStateRecord {
  return {
    account: numberValue(row.account, 'account'),
    valence: numberValue(row.valence, 'valence'),
    arousal: numberValue(row.arousal, 'arousal'),
    updatedAt: numberValue(row.updated_at, 'updated_at'),
    band: stringValue(row.band, 'band') as MoodBand,
    bandSince: numberValue(row.band_since, 'band_since'),
    lastBandChangeAt: numberValue(row.last_band_change_at, 'last_band_change_at'),
  };
}

function moodEventRecord(row: Record<string, unknown>): StoredMoodEvent {
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    time: numberValue(row.time, 'time'),
    source: stringValue(row.source, 'source') as MoodEventSource,
    sessionId: nullableString(row.session_id, 'session_id'),
    senderId: nullableNumber(row.sender_id, 'sender_id'),
    dv: numberValue(row.dv, 'dv'),
    da: numberValue(row.da, 'da'),
    appliedDv: numberValue(row.applied_dv, 'applied_dv'),
    appliedDa: numberValue(row.applied_da, 'applied_da'),
    reason: stringValue(row.reason, 'reason'),
    bandBefore: nullableString(row.band_before, 'band_before') as MoodBand | null,
    bandAfter: nullableString(row.band_after, 'band_after') as MoodBand | null,
  };
}

function tagRecord(row: Record<string, unknown>): StoredTag {
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    sessionId: stringValue(row.session_id, 'session_id'),
    userId: nullableNumber(row.user_id, 'user_id'),
    text: stringValue(row.text, 'text'),
    norm: stringValue(row.norm, 'norm'),
    status: stringValue(row.status, 'status') as TagStatus,
    source: stringValue(row.source, 'source') as TagSource,
    samples: numberValue(row.samples, 'samples'),
    evidence: JSON.parse(stringValue(row.evidence_json, 'evidence_json')) as TagEvidence[],
    firstSeen: numberValue(row.first_seen, 'first_seen'),
    lastSeen: numberValue(row.last_seen, 'last_seen'),
    supersededBy: nullableNumber(row.superseded_by, 'superseded_by'),
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

const tagColumns: Record<keyof TagUpdate, string> = {
  text: 'text',
  norm: 'norm',
  status: 'status',
  samples: 'samples',
  evidence: 'evidence_json',
  lastSeen: 'last_seen',
  supersededBy: 'superseded_by',
  updatedAt: 'updated_at',
};

export function createAffectQueries(database: DatabaseSync): AffectRepositoryQueries {
  const selectMoodState = database.prepare(`
    SELECT account, valence, arousal, updated_at, band, band_since, last_band_change_at
    FROM mood_state
    WHERE account = ?
  `);
  const upsertMoodState = database.prepare(`
    INSERT INTO mood_state (account, valence, arousal, updated_at, band, band_since, last_band_change_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account) DO UPDATE SET
      valence = excluded.valence,
      arousal = excluded.arousal,
      updated_at = excluded.updated_at,
      band = excluded.band,
      band_since = excluded.band_since,
      last_band_change_at = excluded.last_band_change_at
  `);
  const insertMoodEvent = database.prepare(`
    INSERT INTO mood_events
      (account, time, source, session_id, sender_id, dv, da, applied_dv, applied_da, reason, band_before, band_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRecentMoodEvents = database.prepare(`
    SELECT id, account, time, source, session_id, sender_id, dv, da, applied_dv, applied_da, reason, band_before, band_after
    FROM mood_events
    WHERE account = ?
    ORDER BY time DESC, id DESC
    LIMIT ?
  `);
  const selectMoodEventsSince = database.prepare(`
    SELECT id, account, time, source, session_id, sender_id, dv, da, applied_dv, applied_da, reason, band_before, band_after
    FROM mood_events
    WHERE account = ? AND time >= ?
    ORDER BY time, id
  `);
  const insertTag = database.prepare(`
    INSERT INTO tags
      (account, session_id, user_id, text, norm, status, source, samples, evidence_json, first_seen, last_seen, superseded_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectTagById = database.prepare(`
    SELECT id, account, session_id, user_id, text, norm, status, source, samples, evidence_json, first_seen, last_seen, superseded_by, updated_at
    FROM tags
    WHERE id = ?
  `);
  const selectTagsForSubject = database.prepare(`
    SELECT id, account, session_id, user_id, text, norm, status, source, samples, evidence_json, first_seen, last_seen, superseded_by, updated_at
    FROM tags
    WHERE account = ? AND session_id = ? AND user_id IS ?
    ORDER BY last_seen DESC, id DESC
  `);
  const selectTagRun = database.prepare(`
    SELECT account, session_id, last_run_at, last_message_time
    FROM tag_runs
    WHERE account = ? AND session_id = ?
  `);
  const upsertTagRun = database.prepare(`
    INSERT INTO tag_runs (account, session_id, last_run_at, last_message_time)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account, session_id) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      last_message_time = excluded.last_message_time
  `);

  return {
    getMoodState(account) {
      const row = selectMoodState.get(account) as Record<string, unknown> | undefined;
      return row ? moodStateRecord(row) : undefined;
    },

    saveMoodState(state) {
      upsertMoodState.run(
        state.account,
        state.valence,
        state.arousal,
        state.updatedAt,
        state.band,
        state.bandSince,
        state.lastBandChangeAt,
      );
    },

    recordMoodEvent(event) {
      insertMoodEvent.run(
        event.account,
        event.time,
        event.source,
        event.sessionId,
        event.senderId,
        event.dv,
        event.da,
        event.appliedDv,
        event.appliedDa,
        event.reason,
        event.bandBefore,
        event.bandAfter,
      );
    },

    recentMoodEvents(account, count) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError('查询数量必须是非负安全整数');
      }
      if (count === 0) return [];
      const rows = selectRecentMoodEvents.all(account, count) as Array<Record<string, unknown>>;
      return rows.map(moodEventRecord);
    },

    moodEventsSince(account, since) {
      if (!Number.isFinite(since)) throw new RangeError('查询时间必须是有限数字');
      const rows = selectMoodEventsSince.all(account, since) as Array<Record<string, unknown>>;
      return rows.map(moodEventRecord);
    },

    insertTag(tag) {
      const result = insertTag.run(
        tag.account,
        tag.sessionId,
        tag.userId,
        tag.text,
        tag.norm,
        tag.status,
        tag.source,
        tag.samples,
        JSON.stringify(tag.evidence),
        tag.firstSeen,
        tag.lastSeen,
        tag.supersededBy,
        tag.updatedAt,
      );
      return numberValue(result.lastInsertRowid, 'lastInsertRowid');
    },

    tagById(id) {
      if (!Number.isSafeInteger(id) || id <= 0) return undefined;
      const row = selectTagById.get(id) as Record<string, unknown> | undefined;
      return row ? tagRecord(row) : undefined;
    },

    listTagsForSubject(account, sessionId, userId) {
      const rows = selectTagsForSubject.all(account, sessionId, userId) as Array<Record<string, unknown>>;
      return rows.map(tagRecord);
    },

    updateTag(id, update) {
      if (!Number.isSafeInteger(id) || id <= 0) return;
      const entries = (Object.entries(update) as Array<[keyof TagUpdate, TagUpdate[keyof TagUpdate]]>)
        .filter(([, value]) => value !== undefined);
      if (entries.length === 0) return;
      const assignments = entries.map(([field]) => `${tagColumns[field]} = ?`);
      const values = entries.map(([field, value]) => (field === 'evidence' ? JSON.stringify(value) : value));
      database.prepare(`UPDATE tags SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...values as Array<string | number | null>, id);
    },

    getTagRun(account, sessionId) {
      const row = selectTagRun.get(account, sessionId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        account: numberValue(row.account, 'account'),
        sessionId: stringValue(row.session_id, 'session_id'),
        lastRunAt: nullableNumber(row.last_run_at, 'last_run_at'),
        lastMessageTime: nullableNumber(row.last_message_time, 'last_message_time'),
      };
    },

    saveTagRun(run) {
      upsertTagRun.run(run.account, run.sessionId, run.lastRunAt, run.lastMessageTime);
    },
  };
}
