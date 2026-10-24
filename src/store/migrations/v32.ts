import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

type Row = Record<string, unknown>;
const stateColumns = ['dominance', 'main_emotion', 'emotion_since', 'last_emotion_change_at'] as const;
const eventColumns = ['dd', 'applied_dd', 'dominance_after', 'cause_tag'] as const;

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) !== undefined;
}

function columnsOf(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name));
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function moodRegion(valence: number, arousal: number): string {
  if (valence <= -0.15) return arousal >= 0.55 ? 'unpleasant' : 'oppressed';
  if (arousal >= 0.5) return valence < 0.3 ? 'aroused' : 'excited';
  return 'calm';
}

function allColumnsPresent(columns: Set<string>, required: readonly string[]): boolean {
  return required.every((column) => columns.has(column));
}

export const migration: Migration = {
  version: 32,
  up(database) {
    const hasMoodState = tableExists(database, 'mood_state');
    const hasMoodEvents = tableExists(database, 'mood_events');
    if (!hasMoodState && !hasMoodEvents) return;
    const stateColumnsPresent = hasMoodState ? columnsOf(database, 'mood_state') : new Set<string>();
    const eventColumnsPresent = hasMoodEvents ? columnsOf(database, 'mood_events') : new Set<string>();
    const stateDone = !hasMoodState || allColumnsPresent(stateColumnsPresent, stateColumns);
    const eventsDone = !hasMoodEvents || allColumnsPresent(eventColumnsPresent, eventColumns);
    if (stateDone && eventsDone) {
      if (hasMoodState) {
        const schema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mood_state'")
          .get() as { sql?: unknown } | undefined;
        if (typeof schema?.sql !== 'string' || !schema.sql.includes("'unpleasant'")) {
          throw new Error('v32 心情迁移目标结构不一致');
        }
      }
      return;
    }
    if ((hasMoodState && stateColumns.some((column) => stateColumnsPresent.has(column)))
      || (hasMoodEvents && eventColumns.some((column) => eventColumnsPresent.has(column)))) {
      throw new Error('v32 心情迁移结构不完整');
    }
    if (hasMoodState && tableExists(database, 'mood_state_v31')) {
      throw new Error('v32 发现冲突的临时心情表');
    }

    if (hasMoodState) {
      database.exec(`
        ALTER TABLE mood_state RENAME TO mood_state_v31;
      CREATE TABLE mood_state (
        account INTEGER PRIMARY KEY,
        valence REAL NOT NULL,
        arousal REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        band TEXT NOT NULL CHECK (band IN ('unpleasant', 'oppressed', 'calm', 'aroused', 'excited')),
        band_since INTEGER NOT NULL,
        last_band_change_at INTEGER NOT NULL,
        reserve REAL NOT NULL DEFAULT 0.8 CHECK (reserve BETWEEN 0 AND 1),
        reserve_band TEXT NOT NULL DEFAULT 'full' CHECK (reserve_band IN ('full', 'tired', 'drained')),
        reserve_band_since INTEGER,
        reserve_last_change_at INTEGER,
        last_reply_at INTEGER,
        dominance REAL NOT NULL DEFAULT 0 CHECK (dominance BETWEEN -1 AND 1),
        main_emotion TEXT,
        emotion_since INTEGER,
        last_emotion_change_at INTEGER
      );
      INSERT INTO mood_state (
        account, valence, arousal, updated_at, band, band_since, last_band_change_at,
        reserve, reserve_band, reserve_band_since, reserve_last_change_at, last_reply_at, dominance
      )
      SELECT account, valence, arousal, updated_at,
        CASE
          WHEN valence <= -0.15 AND arousal >= 0.55 THEN 'unpleasant'
          WHEN valence <= -0.15 THEN 'oppressed'
          WHEN arousal >= 0.5 AND valence < 0.3 THEN 'aroused'
          WHEN arousal >= 0.5 THEN 'excited'
          ELSE 'calm'
        END,
        band_since, last_band_change_at,
        reserve, reserve_band, reserve_band_since, reserve_last_change_at, last_reply_at, 0
      FROM mood_state_v31;
      DROP TABLE mood_state_v31;
      `);
    }

    if (hasMoodEvents) {
      database.exec(`
      ALTER TABLE mood_events ADD COLUMN dd REAL NOT NULL DEFAULT 0;
      ALTER TABLE mood_events ADD COLUMN applied_dd REAL NOT NULL DEFAULT 0;
      ALTER TABLE mood_events ADD COLUMN dominance_after REAL NOT NULL DEFAULT 0
        CHECK (dominance_after BETWEEN -1 AND 1);
      ALTER TABLE mood_events ADD COLUMN cause_tag TEXT;
      `);
    }

    if (!hasMoodEvents) return;

    const events = database.prepare(`
      SELECT id, account, valence_after, arousal_after
      FROM mood_events
      ORDER BY account, time, id
    `).all() as Row[];
    const previousByAccount = new Map<number, { valence: number; arousal: number }>();
    const update = database.prepare('UPDATE mood_events SET band_before = ?, band_after = ? WHERE id = ?');
    for (const event of events) {
      const account = numberOrNull(event.account);
      const id = numberOrNull(event.id);
      const valence = numberOrNull(event.valence_after);
      const arousal = numberOrNull(event.arousal_after);
      if (account === null || id === null) throw new Error('v32 心情事件身份无效');
      const previous = previousByAccount.get(account);
      const bandBefore = previous ? moodRegion(previous.valence, previous.arousal) : null;
      const bandAfter = valence !== null && arousal !== null ? moodRegion(valence, arousal) : null;
      update.run(bandBefore, bandAfter, id);
      if (valence !== null && arousal !== null) previousByAccount.set(account, { valence, arousal });
    }
  },
};
