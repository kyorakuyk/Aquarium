import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 13,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS profile_migrations (
        name TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL
      );
    `);
  },
};
