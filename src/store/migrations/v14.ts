import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 14,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS activity_suggestion_dismissals (
        session_id TEXT NOT NULL,
        window_key TEXT NOT NULL,
        dismissed_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, window_key)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_suggestion_dismissals_time
        ON activity_suggestion_dismissals (dismissed_at);
    `);
  },
};
