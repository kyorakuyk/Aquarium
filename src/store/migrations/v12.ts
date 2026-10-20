import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 12,
  up(database) {
    const tags = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tags'",
    ).get();
    if (tags) {
      const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
        .map(({ name }) => name));
      const additions = [
        ['category', "TEXT NOT NULL DEFAULT 'misc'"],
        ['subject', 'TEXT'],
        ['polarity', 'TEXT'],
        ['origin', "TEXT NOT NULL DEFAULT 'inferred'"],
        ['locked', 'INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1))'],
      ] as const;
      for (const [name, definition] of additions) {
        if (!columns.has(name)) database.exec(`ALTER TABLE tags ADD COLUMN ${name} ${definition}`);
      }
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS tag_subjects (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE (account, category, name)
      );
    `);
  },
};
