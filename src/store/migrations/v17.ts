import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 17,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tag_vetoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        category TEXT NOT NULL,
        subject_norm TEXT NOT NULL,
        text_norm TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tag_vetoes_scope_norm
        ON tag_vetoes (account, session_id, category, subject_norm, text_norm, user_id);
    `);
  },
};
