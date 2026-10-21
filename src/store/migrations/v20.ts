import type { DatabaseSync } from 'node:sqlite';

export const migrationV20 = {
  version: 20,
  up(database: DatabaseSync): void {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get();
    if (!table) return;
    const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!['user_id', 'text', 'category', 'locked', 'status', 'needs_reclassification']
      .every((column) => columns.has(column))) return;

    database.exec(`
      UPDATE tags
      SET needs_reclassification = 1
      WHERE user_id IS NOT NULL
        AND category = 'speech'
        AND locked = 0
        AND status IN ('candidate', 'confirmed')
        AND length(text) > 2
        AND (
          (substr(text, 1, 1) = '「' AND substr(text, -1, 1) = '」')
          OR (substr(text, 1, 1) = '“' AND substr(text, -1, 1) = '”')
        );
    `);
  },
};
