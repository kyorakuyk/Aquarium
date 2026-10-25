import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 34,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS self_edit_events (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        owner_id INTEGER NOT NULL CHECK (owner_id > 0),
        session_id TEXT NOT NULL,
        persona_id TEXT,
        time INTEGER NOT NULL CHECK (time >= 0),
        message_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        changes_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_self_edit_events_account_time
        ON self_edit_events (account, time DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_self_edit_events_session_time
        ON self_edit_events (account, session_id, time DESC, id DESC);
    `);
  },
};
