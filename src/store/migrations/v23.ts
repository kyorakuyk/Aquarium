import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 23,
  up(database) {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get();
    if (!table) return;
    const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!columns.has('in_prompt')) {
      database.exec('ALTER TABLE tags ADD COLUMN in_prompt INTEGER NOT NULL DEFAULT 0 CHECK (in_prompt IN (0, 1));');
    }
  },
};
