import type { Migration } from './types.ts';

type MoodMigrationColumn = readonly [table: 'mood_state' | 'mood_events', name: string, definition: string];

const columns: readonly MoodMigrationColumn[] = [
  ['mood_state', 'reserve', 'REAL NOT NULL DEFAULT 0.8 CHECK (reserve BETWEEN 0 AND 1)'],
  ['mood_state', 'reserve_band', "TEXT NOT NULL DEFAULT 'full' CHECK (reserve_band IN ('full', 'tired', 'drained'))"],
  ['mood_state', 'reserve_band_since', 'INTEGER'],
  ['mood_state', 'reserve_last_change_at', 'INTEGER'],
  ['mood_state', 'last_reply_at', 'INTEGER'],
  ['mood_events', 'dr', 'REAL NOT NULL DEFAULT 0'],
  ['mood_events', 'applied_dr', 'REAL NOT NULL DEFAULT 0'],
  ['mood_events', 'absorbed', 'REAL NOT NULL DEFAULT 0'],
  ['mood_events', 'reserve_after', 'REAL'],
  ['mood_events', 'appraisal_valid', 'INTEGER CHECK (appraisal_valid IN (0, 1))'],
];

function hasTable(database: Parameters<Migration['up']>[0], table: string): boolean {
  return database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;
}

function hasColumn(database: Parameters<Migration['up']>[0], table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((item) => item.name === column);
}

export const migration: Migration = {
  version: 27,
  up(database) {
    for (const [table, name, definition] of columns) {
      if (!hasTable(database, table) || hasColumn(database, table, name)) continue;
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  },
};
