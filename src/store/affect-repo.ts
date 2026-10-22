import type { DatabaseSync } from 'node:sqlite';
import type { StoreRepository } from './repository.ts';
import { createTagQueries } from './tag-repo.ts';
import { createTagVetoQueries } from './tag-veto-repo.ts';

export type { StoredTag, TagEvidence, TagRecord, TagRunRecord, TagSource, TagStatus, TagUpdate } from './tag-repo.ts';
export type { TagKind } from '../core/impressions/tag-model.ts';

export type MoodBand = 'low' | 'annoyed' | 'calm' | 'happy' | 'excited';
export type MoodEventSource = 'appraise' | 'rule' | 'band';
export type AffinityLevel = 'cold' | 'cool' | 'neutral' | 'warm' | 'close';
export type AffinityEventSource = 'appraise' | 'called' | 'manual' | 'band';

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
  valenceAfter: number;
  arousalAfter: number;
}

export interface StoredMoodEvent extends Omit<MoodEventRecord, 'valenceAfter' | 'arousalAfter'> {
  id: number;
  valenceAfter: number | null;
  arousalAfter: number | null;
}

export interface AffinityStateRecord {
  account: number;
  userId: number;
  value: number;
  level: AffinityLevel;
  levelSince: number;
  lastLevelChangeAt: number;
  lastInteractionAt: number;
  updatedAt: number;
}

export interface AffinityEventRecord {
  account: number;
  userId: number;
  time: number;
  source: AffinityEventSource;
  sessionId: string | null;
  delta: number;
  applied: number;
  reason: string;
  levelBefore: AffinityLevel | null;
  levelAfter: AffinityLevel | null;
}

export interface StoredAffinityEvent extends AffinityEventRecord {
  id: number;
}

export type AffectRepositoryQueries = Pick<StoreRepository,
  'getMoodState' | 'saveMoodState' | 'recordMoodEvent' | 'recentMoodEvents' | 'moodEventsSince' | 'latestMoodEventAtOrBefore'
  | 'getAffinityState' | 'listAffinityStates' | 'saveAffinityState' | 'recordAffinityEvent' | 'recentAffinityEvents' | 'affinityEventsSince' | 'latestSenderNameForAccount'
  | 'insertTag' | 'tagById' | 'deleteTag' | 'listTagsForSubject' | 'listTagsForSession' | 'listGroupTagsForUser' | 'senderNameFor'
  | 'updateTag' | 'deleteActivityTag' | 'getTagRun' | 'saveTagRun'
  | 'deleteTagAndCreateVeto' | 'insertTagVeto' | 'deleteTagVetoesForSession' | 'listTagVetoes' | 'isTagVetoed' | 'deleteTagVeto'
  | 'countMessagesAfter'
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
    valenceAfter: nullableNumber(row.valence_after, 'valence_after'),
    arousalAfter: nullableNumber(row.arousal_after, 'arousal_after'),
  };
}

function affinityStateRecord(row: Record<string, unknown>): AffinityStateRecord {
  return {
    account: numberValue(row.account, 'account'),
    userId: numberValue(row.user_id, 'user_id'),
    value: numberValue(row.value, 'value'),
    level: stringValue(row.level, 'level') as AffinityLevel,
    levelSince: numberValue(row.level_since, 'level_since'),
    lastLevelChangeAt: numberValue(row.last_level_change_at, 'last_level_change_at'),
    lastInteractionAt: numberValue(row.last_interaction_at, 'last_interaction_at'),
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

function affinityEventRecord(row: Record<string, unknown>): StoredAffinityEvent {
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    userId: numberValue(row.user_id, 'user_id'),
    time: numberValue(row.time, 'time'),
    source: stringValue(row.source, 'source') as AffinityEventSource,
    sessionId: nullableString(row.session_id, 'session_id'),
    delta: numberValue(row.delta, 'delta'),
    applied: numberValue(row.applied, 'applied'),
    reason: stringValue(row.reason, 'reason'),
    levelBefore: nullableString(row.level_before, 'level_before') as AffinityLevel | null,
    levelAfter: nullableString(row.level_after, 'level_after') as AffinityLevel | null,
  };
}

export function createAffectQueries(database: DatabaseSync): AffectRepositoryQueries {
  const tags = createTagQueries(database);
  const tagVetoes = createTagVetoQueries(database, tags);
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
      (account, time, source, session_id, sender_id, dv, da, applied_dv, applied_da, reason, band_before, band_after, valence_after, arousal_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRecentMoodEvents = database.prepare(`
    SELECT id, account, time, source, session_id, sender_id, dv, da, applied_dv, applied_da, reason, band_before, band_after, valence_after, arousal_after
    FROM mood_events
    WHERE account = ?
    ORDER BY time DESC, id DESC
    LIMIT ?
  `);
  const selectMoodEventsSince = database.prepare(`
    SELECT id, account, time, source, session_id, sender_id, dv, da, applied_dv, applied_da, reason, band_before, band_after, valence_after, arousal_after
    FROM mood_events
    WHERE account = ? AND time >= ?
    ORDER BY time, id
  `);
  const selectLatestMoodEventAtOrBefore = database.prepare(`
    SELECT id, account, time, source, session_id, sender_id, dv, da, applied_dv, applied_da,
      reason, band_before, band_after, valence_after, arousal_after
    FROM mood_events
    WHERE account = ? AND time <= ? AND valence_after IS NOT NULL AND arousal_after IS NOT NULL
    ORDER BY time DESC, id DESC
    LIMIT 1
  `);
  const selectAffinityState = database.prepare(`
    SELECT account, user_id, value, level, level_since, last_level_change_at, last_interaction_at, updated_at
    FROM affinity_state
    WHERE account = ? AND user_id = ?
  `);
  const selectAffinityStates = database.prepare(`
    SELECT account, user_id, value, level, level_since, last_level_change_at, last_interaction_at, updated_at
    FROM affinity_state
    WHERE account = ?
    ORDER BY user_id
  `);
  const upsertAffinityState = database.prepare(`
    INSERT INTO affinity_state
      (account, user_id, value, level, level_since, last_level_change_at, last_interaction_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account, user_id) DO UPDATE SET
      value = excluded.value,
      level = excluded.level,
      level_since = excluded.level_since,
      last_level_change_at = excluded.last_level_change_at,
      last_interaction_at = excluded.last_interaction_at,
      updated_at = excluded.updated_at
  `);
  const insertAffinityEvent = database.prepare(`
    INSERT INTO affinity_events
      (account, user_id, time, source, session_id, delta, applied, reason, level_before, level_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRecentAffinityEvents = database.prepare(`
    SELECT id, account, user_id, time, source, session_id, delta, applied, reason, level_before, level_after
    FROM affinity_events
    WHERE account = ? AND user_id = ?
    ORDER BY time DESC, id DESC
    LIMIT ?
  `);
  const selectAffinityEventsSince = database.prepare(`
    SELECT id, account, user_id, time, source, session_id, delta, applied, reason, level_before, level_after
    FROM affinity_events
    WHERE account = ? AND user_id = ? AND time >= ?
    ORDER BY time, id
  `);
  const selectLatestSenderNameForAccount = database.prepare(`
    SELECT sender_name
    FROM messages
    WHERE session_id LIKE ? AND sender_id = ? AND is_self = 0
    ORDER BY time DESC, id DESC
    LIMIT 1
  `);

  return {
    ...tags,
    ...tagVetoes,
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
        event.valenceAfter,
        event.arousalAfter,
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

    latestMoodEventAtOrBefore(account, time) {
      if (!Number.isFinite(time)) throw new RangeError('查询时间必须是有限数字');
      const row = selectLatestMoodEventAtOrBefore.get(account, time) as Record<string, unknown> | undefined;
      return row ? moodEventRecord(row) : undefined;
    },

    getAffinityState(account, userId) {
      const row = selectAffinityState.get(account, userId) as Record<string, unknown> | undefined;
      return row ? affinityStateRecord(row) : undefined;
    },

    listAffinityStates(account) {
      const rows = selectAffinityStates.all(account) as Array<Record<string, unknown>>;
      return rows.map(affinityStateRecord);
    },

    saveAffinityState(state) {
      upsertAffinityState.run(
        state.account,
        state.userId,
        state.value,
        state.level,
        state.levelSince,
        state.lastLevelChangeAt,
        state.lastInteractionAt,
        state.updatedAt,
      );
    },

    recordAffinityEvent(event) {
      insertAffinityEvent.run(
        event.account,
        event.userId,
        event.time,
        event.source,
        event.sessionId,
        event.delta,
        event.applied,
        event.reason,
        event.levelBefore,
        event.levelAfter,
      );
    },

    recentAffinityEvents(account, userId, count) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError('查询数量必须是非负安全整数');
      }
      if (count === 0) return [];
      const rows = selectRecentAffinityEvents.all(account, userId, count) as Array<Record<string, unknown>>;
      return rows.map(affinityEventRecord);
    },

    affinityEventsSince(account, userId, since) {
      if (!Number.isFinite(since)) throw new RangeError('查询时间必须是有限数字');
      const rows = selectAffinityEventsSince.all(account, userId, since) as Array<Record<string, unknown>>;
      return rows.map(affinityEventRecord);
    },

    latestSenderNameForAccount(account, userId) {
      const row = selectLatestSenderNameForAccount.get(`${account}:%`, userId) as Record<string, unknown> | undefined;
      return row ? stringValue(row.sender_name, 'sender_name') : undefined;
    },

  };
}
