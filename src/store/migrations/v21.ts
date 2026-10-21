import type { DatabaseSync } from 'node:sqlite';

export const migrationV21 = {
  version: 21,
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS group_summaries (
        account INTEGER NOT NULL CHECK (account > 0),
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        manual INTEGER NOT NULL CHECK (manual IN (0, 1)),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        PRIMARY KEY (account, session_id)
      );

      CREATE TABLE IF NOT EXISTS tag_drop_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account INTEGER NOT NULL CHECK (account > 0),
        session_id TEXT NOT NULL,
        user_id INTEGER CHECK (user_id IS NULL OR user_id > 0),
        category TEXT NOT NULL,
        text TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason = 'schedule_by_stats'),
        time INTEGER NOT NULL CHECK (time >= 0)
      );

      CREATE INDEX IF NOT EXISTS tag_drop_events_recent_idx
        ON tag_drop_events (account, session_id, user_id, reason, time DESC, id DESC);
    `);
  },
};
