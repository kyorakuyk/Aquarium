import type { DatabaseSync } from 'node:sqlite';
import type { Migration, MigrationContext } from './types.ts';

type AffinityLevel =
  | 'enemy' | 'loathe' | 'dislike' | 'uncomfortable' | 'distant'
  | 'unfamiliar' | 'acquaintance' | 'ordinary_friend' | 'more_than_friends' | 'lover';

type AffinityTiers = { positive: readonly number[]; negative: readonly number[] };

const LEVELS: readonly AffinityLevel[] = [
  'enemy', 'loathe', 'dislike', 'uncomfortable', 'distant',
  'unfamiliar', 'acquaintance', 'ordinary_friend', 'more_than_friends', 'lover',
];
const DEFAULT_TIERS: AffinityTiers = {
  positive: [15, 35, 60, 85],
  negative: [-85, -60, -35, -15],
};
const LEGACY_LEVELS: Record<string, AffinityLevel> = {
  cold: 'loathe',
  cool: 'dislike',
  neutral: 'unfamiliar',
  warm: 'ordinary_friend',
  close: 'more_than_friends',
};

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function numberField(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`旧好感字段 ${field} 不是数字`);
}

function textField(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`旧好感字段 ${field} 不是文本`);
}

function nullableTextField(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return textField(value, field);
}

function levelAt(value: number, tiers: AffinityTiers): AffinityLevel {
  const boundaries = [...tiers.negative, 0, ...tiers.positive];
  const index = boundaries.findIndex((boundary) => value < boundary);
  return LEVELS[index < 0 ? LEVELS.length - 1 : index] ?? 'lover';
}

function mapLegacyLevel(value: unknown): AffinityLevel | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !Object.hasOwn(LEGACY_LEVELS, value)) {
    throw new Error(`旧好感等级无效：${String(value)}`);
  }
  return LEGACY_LEVELS[value] ?? null;
}

export const migration: Migration = {
  version: 31,
  up(database, context) {
    const hasPersonaAffinityState = tableExists(database, 'persona_affinity_state');
    const hasPersonaAffinityEvents = tableExists(database, 'persona_affinity_events');
    if (hasPersonaAffinityState && hasPersonaAffinityEvents) return;
    if (hasPersonaAffinityState !== hasPersonaAffinityEvents) {
      throw new Error('v31 人设好感迁移表不完整');
    }

    const tiers = context?.affinityTiers ?? DEFAULT_TIERS;
    const hasLegacyState = tableExists(database, 'affinity_state');
    const hasLegacyEvents = tableExists(database, 'affinity_events');
    const states = hasLegacyState
      ? database.prepare(`
        SELECT account, user_id, value, level_since, last_level_change_at, last_interaction_at, updated_at
        FROM affinity_state
      `).all() as Array<Record<string, number>>
      : [];
    const events = hasLegacyEvents
      ? database.prepare(`
        SELECT id, account, user_id, time, source, session_id, delta, applied, reason, level_before, level_after
        FROM affinity_events
      `).all() as Array<Record<string, unknown>>
      : [];

    if (hasLegacyState) database.exec('ALTER TABLE affinity_state RENAME TO affinity_state_v30;');
    if (hasLegacyEvents) {
      database.exec(`
        ALTER TABLE affinity_events RENAME TO affinity_events_v30;
        DROP INDEX IF EXISTS idx_affinity_events_account_user_time;
      `);
    }

    database.exec(`
      CREATE TABLE affinity_state (
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        value REAL NOT NULL CHECK (value >= -100 AND value <= 100),
        level TEXT NOT NULL CHECK (level IN (
          'enemy', 'loathe', 'dislike', 'uncomfortable', 'distant',
          'unfamiliar', 'acquaintance', 'ordinary_friend', 'more_than_friends', 'lover'
        )),
        level_since INTEGER NOT NULL,
        last_level_change_at INTEGER NOT NULL,
        last_interaction_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account, user_id)
      );
      CREATE TABLE affinity_events (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        time INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('appraise', 'called', 'manual', 'band')),
        session_id TEXT,
        delta REAL NOT NULL,
        applied REAL NOT NULL,
        reason TEXT NOT NULL,
        level_before TEXT CHECK (level_before IS NULL OR level_before IN (
          'enemy', 'loathe', 'dislike', 'uncomfortable', 'distant',
          'unfamiliar', 'acquaintance', 'ordinary_friend', 'more_than_friends', 'lover'
        )),
        level_after TEXT CHECK (level_after IS NULL OR level_after IN (
          'enemy', 'loathe', 'dislike', 'uncomfortable', 'distant',
          'unfamiliar', 'acquaintance', 'ordinary_friend', 'more_than_friends', 'lover'
        ))
      );
      CREATE INDEX idx_affinity_events_account_user_time ON affinity_events (account, user_id, time);

      CREATE TABLE IF NOT EXISTS persona_affinity_state (
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        persona_id TEXT NOT NULL CHECK (length(persona_id) BETWEEN 1 AND 64),
        value REAL NOT NULL CHECK (value >= -100 AND value <= 100),
        level TEXT NOT NULL CHECK (level IN (
          'enemy', 'loathe', 'dislike', 'uncomfortable', 'distant',
          'unfamiliar', 'acquaintance', 'ordinary_friend', 'more_than_friends', 'lover'
        )),
        level_since INTEGER NOT NULL,
        last_level_change_at INTEGER NOT NULL,
        last_interaction_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account, user_id, persona_id)
      );
      CREATE TABLE IF NOT EXISTS persona_affinity_events (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        persona_id TEXT NOT NULL CHECK (length(persona_id) BETWEEN 1 AND 64),
        time INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('appraise', 'called', 'manual', 'band')),
        session_id TEXT,
        delta REAL NOT NULL,
        applied REAL NOT NULL,
        reason TEXT NOT NULL,
        level_before TEXT CHECK (level_before IS NULL OR level_before IN (
          'enemy', 'loathe', 'dislike', 'uncomfortable', 'distant',
          'unfamiliar', 'acquaintance', 'ordinary_friend', 'more_than_friends', 'lover'
        )),
        level_after TEXT CHECK (level_after IS NULL OR level_after IN (
          'enemy', 'loathe', 'dislike', 'uncomfortable', 'distant',
          'unfamiliar', 'acquaintance', 'ordinary_friend', 'more_than_friends', 'lover'
        ))
      );
      CREATE INDEX IF NOT EXISTS idx_persona_affinity_events_account_user_persona_time
        ON persona_affinity_events (account, user_id, persona_id, time);
    `);

    const insertState = database.prepare(`
      INSERT INTO affinity_state
        (account, user_id, value, level, level_since, last_level_change_at, last_interaction_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const state of states) {
      const value = Math.max(-100, Math.min(100, (numberField(state.value, 'value') - 50) * 2));
      insertState.run(
        state.account,
        state.user_id,
        value,
        levelAt(value, tiers),
        state.level_since,
        state.last_level_change_at,
        state.last_interaction_at,
        state.updated_at,
      );
    }

    const insertEvent = database.prepare(`
      INSERT INTO affinity_events
        (id, account, user_id, time, source, session_id, delta, applied, reason, level_before, level_after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      if (typeof event.delta !== 'number' || typeof event.applied !== 'number') {
        throw new Error('旧好感事件数值无效');
      }
      insertEvent.run(
        numberField(event.id, 'id'),
        numberField(event.account, 'account'),
        numberField(event.user_id, 'user_id'),
        numberField(event.time, 'time'),
        textField(event.source, 'source'),
        nullableTextField(event.session_id, 'session_id'),
        numberField(event.delta, 'delta') * 2,
        numberField(event.applied, 'applied') * 2,
        textField(event.reason, 'reason'),
        mapLegacyLevel(event.level_before),
        mapLegacyLevel(event.level_after),
      );
    }
    if (hasLegacyState) database.exec('DROP TABLE affinity_state_v30;');
    if (hasLegacyEvents) database.exec('DROP TABLE affinity_events_v30;');
  },
};
