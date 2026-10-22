import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 22,
  up(database) {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get();
    if (!table) return;
    const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!columns.has('kind')) {
      database.exec("ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'view' CHECK (kind IN ('fact', 'view'));");
    }
    if (!columns.has('category')) return;

    const polarityIsView = columns.has('polarity') ? "COALESCE(polarity, '') <> '' OR " : '';
    database.exec(`
      UPDATE tags
      SET kind = CASE
        WHEN ${polarityIsView}category IN ('atmosphere', 'personality', 'speech', 'social', 'dislike', 'misc')
          THEN 'view'
        ELSE 'fact'
      END;
    `);
  },
};
