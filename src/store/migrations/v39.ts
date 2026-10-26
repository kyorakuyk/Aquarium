import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table));
}

export const migration: Migration = {
  version: 39,
  up(database) {
    if (!hasTable(database, 'persona_diaries')) return;
    const columns = new Set((database.prepare('PRAGMA table_info(persona_diaries)').all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!columns.has('source_memo_ids_json')) {
      database.exec("ALTER TABLE persona_diaries ADD COLUMN source_memo_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
  },
};
