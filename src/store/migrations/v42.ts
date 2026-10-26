import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

type AnchorColumn = readonly ['mood_state' | 'mood_events', string];

const columns: readonly AnchorColumn[] = [
  ['mood_state', 'valence_d0'],
  ['mood_state', 'valence_u'],
  ['mood_state', 'arousal_d0'],
  ['mood_state', 'arousal_u'],
  ['mood_state', 'dominance_d0'],
  ['mood_state', 'dominance_u'],
  ['mood_events', 'valence_u_after'],
  ['mood_events', 'arousal_u_after'],
  ['mood_events', 'dominance_u_after'],
];

function hasTable(database: DatabaseSync, table: string): boolean {
  return database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((item) => item.name === column);
}

export const migration: Migration = {
  version: 42,
  up(database) {
    for (const [table, column] of columns) {
      if (!hasTable(database, table) || hasColumn(database, table, column)) continue;
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} REAL`);
    }
  },
};
