import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 15,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS member_summaries (
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account, user_id)
      );
    `);
  },
};
