import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 16,
  up(database) {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get();
    if (!table) return;
    const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!columns.has('needs_reclassification')) {
      database.exec(`
        ALTER TABLE tags
        ADD COLUMN needs_reclassification INTEGER NOT NULL DEFAULT 0
        CHECK (needs_reclassification IN (0, 1));
      `);
    }
    if (!['user_id', 'category', 'locked', 'status'].every((column) => columns.has(column))) return;
    database.exec(`
      UPDATE tags
      SET needs_reclassification = 1
      WHERE user_id IS NULL
        AND category <> 'schedule'
        AND locked = 0
        AND status <> 'superseded';
      CREATE INDEX IF NOT EXISTS idx_tags_needs_reclassification
        ON tags (needs_reclassification, locked, status);
    `);
  },
};
