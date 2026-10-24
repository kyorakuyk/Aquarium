import type { DatabaseSync } from 'node:sqlite';
import type {
  AffinityEventRecord,
  AffinityEventSource,
  AffinityLevel,
  AffinityStateRecord,
} from './affect-repo.ts';

export interface PersonaAffinityStateRecord extends AffinityStateRecord {
  personaId: string;
}

export interface PersonaAffinityEventRecord extends AffinityEventRecord {
  personaId: string;
}

export interface StoredPersonaAffinityEvent extends PersonaAffinityEventRecord {
  id: number;
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

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, field);
}

function stateRecord(row: Record<string, unknown>): PersonaAffinityStateRecord {
  return {
    account: numberValue(row.account, 'account'),
    userId: numberValue(row.user_id, 'user_id'),
    personaId: stringValue(row.persona_id, 'persona_id'),
    value: numberValue(row.value, 'value'),
    level: stringValue(row.level, 'level') as AffinityLevel,
    levelSince: numberValue(row.level_since, 'level_since'),
    lastLevelChangeAt: numberValue(row.last_level_change_at, 'last_level_change_at'),
    lastInteractionAt: numberValue(row.last_interaction_at, 'last_interaction_at'),
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

function eventRecord(row: Record<string, unknown>): StoredPersonaAffinityEvent {
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    userId: numberValue(row.user_id, 'user_id'),
    personaId: stringValue(row.persona_id, 'persona_id'),
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

export function createPersonaAffinityQueries(database: DatabaseSync) {
  const selectState = database.prepare(`
    SELECT account, user_id, persona_id, value, level, level_since,
      last_level_change_at, last_interaction_at, updated_at
    FROM persona_affinity_state
    WHERE account = ? AND user_id = ? AND persona_id = ?
  `);
  const selectStates = database.prepare(`
    SELECT account, user_id, persona_id, value, level, level_since,
      last_level_change_at, last_interaction_at, updated_at
    FROM persona_affinity_state
    WHERE account = ? AND persona_id = ?
    ORDER BY user_id
  `);
  const upsertState = database.prepare(`
    INSERT INTO persona_affinity_state
      (account, user_id, persona_id, value, level, level_since,
        last_level_change_at, last_interaction_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account, user_id, persona_id) DO UPDATE SET
      value = excluded.value,
      level = excluded.level,
      level_since = excluded.level_since,
      last_level_change_at = excluded.last_level_change_at,
      last_interaction_at = excluded.last_interaction_at,
      updated_at = excluded.updated_at
  `);
  const insertEvent = database.prepare(`
    INSERT INTO persona_affinity_events
      (account, user_id, persona_id, time, source, session_id, delta, applied,
        reason, level_before, level_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRecentEvents = database.prepare(`
    SELECT id, account, user_id, persona_id, time, source, session_id, delta, applied,
      reason, level_before, level_after
    FROM persona_affinity_events
    WHERE account = ? AND user_id = ? AND persona_id = ?
    ORDER BY time DESC, id DESC
    LIMIT ?
  `);
  const selectEventsSince = database.prepare(`
    SELECT id, account, user_id, persona_id, time, source, session_id, delta, applied,
      reason, level_before, level_after
    FROM persona_affinity_events
    WHERE account = ? AND user_id = ? AND persona_id = ? AND time >= ?
    ORDER BY time, id
  `);

  return {
    getPersonaAffinityState(account: number, userId: number, personaId: string) {
      const row = selectState.get(account, userId, personaId) as Record<string, unknown> | undefined;
      return row ? stateRecord(row) : undefined;
    },
    listPersonaAffinityStates(account: number, personaId: string) {
      const rows = selectStates.all(account, personaId) as Array<Record<string, unknown>>;
      return rows.map(stateRecord);
    },
    savePersonaAffinityState(state: PersonaAffinityStateRecord) {
      upsertState.run(
        state.account,
        state.userId,
        state.personaId,
        state.value,
        state.level,
        state.levelSince,
        state.lastLevelChangeAt,
        state.lastInteractionAt,
        state.updatedAt,
      );
    },
    recordPersonaAffinityEvent(event: PersonaAffinityEventRecord) {
      insertEvent.run(
        event.account,
        event.userId,
        event.personaId,
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
    recentPersonaAffinityEvents(account: number, userId: number, personaId: string, count: number) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError('查询数量必须是非负安全整数');
      }
      if (count === 0) return [];
      const rows = selectRecentEvents.all(account, userId, personaId, count) as Array<Record<string, unknown>>;
      return rows.map(eventRecord);
    },
    personaAffinityEventsSince(account: number, userId: number, personaId: string, since: number) {
      if (!Number.isFinite(since)) throw new RangeError('查询时间必须是有限数字');
      const rows = selectEventsSince.all(account, userId, personaId, since) as Array<Record<string, unknown>>;
      return rows.map(eventRecord);
    },
  };
}
